import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Repo } from '../db/repo/index.ts';
import { databaseRefusal } from '../db/repo/errors.ts';
import { decisionRequestSchemas } from '../contracts/schemas/index.ts';

export type DecisionKind = keyof typeof decisionRequestSchemas;
export const decisionKinds = Object.keys(decisionRequestSchemas) as DecisionKind[];
type Channel = 'client' | 'telegram' | 'api';
export type DecisionInput = {
  taskId: string; kind: DecisionKind; channel: Channel; body: Record<string, unknown>;
  idempotencyKey: string; windowSeconds: number; actorId?: string; engineerRunId?: string;
  deviceSessionId?: string | null; pressId?: string | null; confirm?: string; now?: Date;
  /** The actual request path, when it differs from the standard task decision route. */
  path?: string;
};
export class DecisionProblem extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
type Recorded = { id: string; kind: string; delivery_state: string; refusal_reason: string | null };
type ConfirmationRequired = { code: 'confirmation_required'; confirmation_id: string; nonce: string; expires_at: string };
export type DecisionResult = { status: 202; body: Recorded; location: string; replayed: boolean } | { status: 409; body: ConfirmationRequired; replayed: boolean };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};
const routes: Record<DecisionKind, string> = { approve: 'approve', reject: 'reject', request_changes: 'request-changes', cancel: 'cancel', pause: 'pause', resume: 'resume', add_feedback: 'feedback', change_priority: 'priority', revise_requirements: 'revisions', resolve_block: 'resolve-block', force_close: 'force-close', allow_agent: 'allow-agent' };
const dangerous = new Set<DecisionKind>(['cancel', 'reject', 'force_close']);
const answer = (row: { id: string; kind: string | null; deliveryState: string | null; refusalReason: string | null }, replayed: boolean): DecisionResult => ({ status: 202, body: { id: row.id, kind: row.kind!, delivery_state: row.deliveryState!, refusal_reason: row.refusalReason }, location: `/decisions/${row.id}`, replayed });

export async function recordDecision(repo: Repo, input: DecisionInput): Promise<DecisionResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) || !decisionRequestSchemas[input.kind]?.safeParse(input.body).success || Boolean(input.actorId) === Boolean(input.engineerRunId)) throw new DecisionProblem('validation_failed', 422);
  const path = input.path ?? `/tasks/${input.taskId}/${routes[input.kind]}`;
  const requestHash = hash(canonical(['POST', path, input.body]));
  const now = input.now ?? new Date();
  const run = async (): Promise<DecisionResult> => repo.transaction(async tx => {
    await tx.decisions.lockKey(input.actorId ?? input.engineerRunId!, input.idempotencyKey);
    const existing = input.actorId ? await tx.decisions.byActorKey(input.actorId, input.idempotencyKey) : await tx.decisions.byEngineerKey(input.engineerRunId!, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DecisionProblem('idempotency_conflict');
      return answer(existing, true);
    }
    const key = input.actorId ? await tx.idempotencyKeys.get(input.actorId, input.idempotencyKey) : undefined;
    if (key) {
      if (key.requestHash !== requestHash) throw new DecisionProblem('idempotency_conflict');
      if (key.state !== 'done') throw new DecisionProblem('idempotency_in_progress');
      return { status: 409, body: key.responseBody as ConfirmationRequired, replayed: true };
    }
    let confirmationId: string | undefined;
    if (dangerous.has(input.kind)) {
      if (!input.actorId) throw new DecisionProblem('owner_only', 422);
      if (!input.confirm) {
        const claim = await tx.idempotencyKeys.claim({ actorId: input.actorId, key: input.idempotencyKey, requestHash, state: 'in_progress' });
        if (claim.replayed) {
          if (claim.row.requestHash !== requestHash) throw new DecisionProblem('idempotency_conflict');
          if (claim.row.state !== 'done') throw new DecisionProblem('idempotency_in_progress');
          return { status: 409, body: claim.row.responseBody as ConfirmationRequired, replayed: true };
        }
        const id = randomUUID(), nonce = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + input.windowSeconds * 1000);
        await tx.confirmations.create({ id, actorId: input.actorId, channel: input.channel, deviceSessionId: input.deviceSessionId ?? null, operation: input.kind, targetType: 'task', targetId: input.taskId, requestHash, nonceHash: hash(nonce), issuedAt: now, expiresAt });
        const body: ConfirmationRequired = { code: 'confirmation_required', confirmation_id: id, nonce, expires_at: expiresAt.toISOString() };
        await tx.idempotencyKeys.complete(input.actorId, input.idempotencyKey, 409, body);
        return { status: 409, body, replayed: false };
      }
      const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i.exec(input.confirm);
      if (!match) throw new DecisionProblem('confirmation_invalid');
      const confirmation = await tx.confirmations.get(match[1]!);
      const expected = confirmation?.nonceHash;
      const actual = hash(match[2]!);
      if (!expected || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new DecisionProblem('confirmation_invalid');
      confirmationId = match[1];
    }
    const decisionId = randomUUID(), outboxId = randomUUID();
    const result = await tx.decisions.insertPair({ decision: { id: decisionId, taskId: input.taskId, kind: input.kind, actorId: input.actorId ?? null, engineerRunId: input.engineerRunId ?? null, channel: input.channel, deviceSessionId: input.deviceSessionId ?? null, pressId: input.pressId ?? null, revisionNumber: typeof input.body.revision_number === 'number' ? input.body.revision_number : null, payload: input.body, confirmationId: confirmationId ?? null, idempotencyKey: input.idempotencyKey, requestHash, deliveryState: 'recorded', outboxId }, outbox: { id: outboxId, kind: 'deliver_decision', taskId: input.taskId, decisionId, payload: { decision_id: decisionId }, state: 'pending', attempts: 0 } });
    if (confirmationId && !await tx.confirmations.consume({ id: confirmationId, actorId: input.actorId!, channel: input.channel, deviceSessionId: input.deviceSessionId ?? null, operation: input.kind, targetType: 'task', targetId: input.taskId, requestHash, now, decisionId })) throw new DecisionProblem('confirmation_invalid');
    return answer(result.decision, false);
  });
  try { return await run(); } catch (error) {
    const refusal = databaseRefusal(error);
    if (refusal?.reason === 'invalid standing task operation') throw new DecisionProblem('not_allowed_in_state');
    for (let cause: any = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
      if (cause.code === '23505' && (cause.constraint_name === 'task_decisions_press' || cause.constraint === 'task_decisions_press')) throw new DecisionProblem('press_replayed');
    }
    throw error;
  }
}
