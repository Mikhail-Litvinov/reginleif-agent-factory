import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { createApiServer, HandlerContext } from '../api/server.ts';
import { mutationHash } from '../api/decisions.ts';
import { canonicalJson, confirmationWindow, ConfirmationSettingError, requestHash, secondPress } from '../api/second-press.ts';
import type { Repo } from '../db/repo/index.ts';
import { RegistryRefusedError } from '../db/repo/registry.ts';
import { createRegistryService, RegistryConflictError } from '../registry/service.ts';
import { isSensitive } from '../registry/policy.ts';
import { pageLimits } from '../api/handlers/settings.ts';
import * as Q from '../contracts/schemas/requests.ts';
import * as R from '../contracts/schemas/resources.ts';

type RelayRequest = { method: 'GET' | 'POST'; path: string; token: string; key?: string; body?: unknown; headers?: Record<string, string> };
export function createRelayClient(token: string, transport: (request: RelayRequest) => Promise<{ status: number; body: unknown }>) {
  return {
    registerPoll: (body: z.infer<typeof Q.RegistryPoll>, key: string) => transport({ method: 'POST', path: '/registry/polls', token, key, body }),
    capture: (body: z.infer<typeof Q.Capture>, key: string) => transport({ method: 'POST', path: '/registry/captures', token, key, body }),
    registerDraftPress: (draft: string, key: string) => transport({ method: 'POST', path: `/registry/drafts/${encodeURIComponent(draft)}/presses`, token, key }),
    confirmDraft: (draft: string, body: z.infer<typeof Q.DraftPress>, key: string, confirmation?: string) => transport({ method: 'POST', path: `/registry/drafts/${encodeURIComponent(draft)}/confirm`, token, key, body, ...(confirmation ? { headers: { 'X-Confirm': confirmation } } : {}) }),
    drafts: (cursor?: string) => transport({ method: 'GET', path: `/registry/drafts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, token }),
  };
}

function project(schema: z.ZodObject, row: object): Record<string, unknown> {
  const data = row as Record<string, unknown>;
  return Object.fromEntries(Object.keys(schema.shape).map(key => {
    const value = data[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
    return [key, value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value ?? null];
  }));
}

function actorId(value: unknown): unknown {
  return value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value ?? null;
}

async function registryRecord(repo: Pick<Repo, 'registry'>, row: Awaited<ReturnType<Repo['registry']['records']['list']>>[number]) {
  const links = await repo.registry.links.forRecord(row.id);
  const history = await repo.registry.records.history(row.id);
  return R.RegistryRecord.parse({ ...project(R.RegistryRecord, row),
    created_by: actorId(row.createdBy), status_changed_by: actorId(row.statusChangedBy),
    status_changed_at: row.statusChangedAt?.toISOString() ?? null, tags: row.tags ?? [],
    links: links.map(link => ({ ...project(R.RegistryLink, link), created_by: actorId(link.createdBy) })),
    history: history.map(item => project(R.AuditEntry, item)),
  });
}

export function registerRelayHandlers(api: ReturnType<typeof createApiServer>, repo: Repo): void {
  api.register('POST', '/registry/drafts/{id}/presses', async context => {
    const key = context.request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return { status: 422, body: { code: 'validation_failed' } };
    try {
      return await repo.transaction(async tx => {
        const actor = context.identity!.id;
        const digest = mutationHash('POST', `/registry/drafts/${context.params.id}/presses`, null);
        const claim = await tx.idempotencyKeys.claim({ actorId: actor, key, requestHash: digest, state: 'in_progress' });
        if (claim.replayed) {
          if (claim.row.requestHash !== digest) return { status: 409, body: { code: 'idempotency_conflict' } };
          if (claim.row.state !== 'done') return { status: 409, body: { code: 'idempotency_in_progress' } };
          return { status: claim.row.responseStatus!, body: claim.row.responseBody, headers: { 'Idempotent-Replay': 'true' } };
        }
        const draft = await tx.registry.records.get(context.params.id);
        if (!draft) throw new RegistryRefusedError('not_found');
        if (draft.status !== 'draft') throw new RegistryRefusedError('not_allowed_in_state');
        const expires = new Date(context.now.getTime() + await confirmationWindow(tx) * 1000);
        const press = randomUUID();
        await tx.registry.draftPresses.register(press, draft.id, actor, expires);
        const body = { press_id: press, expires_at: expires.toISOString() };
        await tx.idempotencyKeys.complete(actor, key, 201, body);
        return { status: 201, body };
      });
    } catch (error) {
      if (error instanceof ConfirmationSettingError) return { status: 503, body: { code: 'unavailable' } };
      if (error instanceof RegistryRefusedError) return { status: error.reason === 'not_found' ? 404 : 409, body: { code: error.reason } };
      throw error;
    }
  });
  api.register('POST', '/registry/drafts/{id}/confirm', async context => {
    const key = context.request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return { status: 422, body: { code: 'validation_failed' } };
    const input = context.body as z.infer<typeof Q.DraftPress>;
    if (!Number.isSafeInteger(input.telegram_user_id) || input.telegram_user_id <= 0) return { status: 422, body: { code: 'validation_failed' } };
    try {
      return await repo.transaction(async tx => {
        const owner = await tx.owners.byTelegramUserId(BigInt(input.telegram_user_id));
        if (!owner) return { status: 403, body: { code: 'forbidden' } };
        const used = await tx.registry.draftPresses.consume(input.press_id, context.params.id, context.identity!.id, owner.id, context.now);
        if (used === 'foreign') return { status: 403, body: { code: 'forbidden' } };
        if (used === 'used') return { status: 409, body: { code: 'press_replayed' } };
        if (used === 'expired') return { status: 409, body: { code: 'press_expired' } };
        const draft = await tx.registry.records.get(context.params.id);
        if (!draft) throw new RegistryRefusedError('not_found');
        if (draft.status !== 'draft') throw new RegistryRefusedError('not_allowed_in_state');
        const actorKey = context.identity!.id;
        const digest = mutationHash('POST', `/registry/drafts/${draft.id}/confirm`, input);
        const claim = await tx.idempotencyKeys.claim({ actorId: actorKey, key, requestHash: digest, state: 'in_progress' });
        if (claim.replayed) throw new RegistryRefusedError(claim.row.requestHash === digest ? 'idempotency_in_progress' : 'idempotency_conflict');
        if (isSensitive(draft.category)) {
          const first = await secondPress(tx, context, { actorId: owner.id, channel: 'telegram', operation: 'registry-draft-activate', targetType: 'registry_records', targetId: draft.id, requestHash: requestHash(canonicalJson({ draft_id: draft.id })), now: context.now });
          if (first) {
            // The one-time nonce is returned to the caller; only its hash belongs in storage.
            await tx.idempotencyKeys.complete(actorKey, key, first.status, { code: first.body.code });
            return first;
          }
        }
        const service = createRegistryService({ ...tx, transaction: async (fn: any) => fn(tx) } as Repo);
        const row = await service.changeStatus({ type: 'owner', id: owner.id, channel: 'telegram', pressId: input.press_id }, draft.id, 'active', context.now);
        if (!row) throw new RegistryRefusedError('not_found');
        const body = await registryRecord(tx, row);
        await tx.idempotencyKeys.complete(actorKey, key, 200, body);
        return { status: 200, body };
      });
    } catch (error) {
      if (error instanceof ConfirmationSettingError) return { status: 503, body: { code: 'unavailable' } };
      if (error instanceof RegistryConflictError) return { status: 409, body: { code: 'guard_conflict', conflicts_with: error.conflictsWith } };
      if (error instanceof RegistryRefusedError) return { status: error.reason === 'not_found' ? 404 : error.reason === 'forbidden' ? 403 : 409, body: { code: error.reason } };
      throw error;
    }
  });
}

// POST /registry/polls and POST /registry/captures are registered once, by registerRegistryHandlers, which wraps these
// handlers in its registry.enabled guard. The idempotency claim and the registry write share one transaction, so the
// service is built on that transaction unless a test injects its own.
export function relayMutationHandler(repo: Repo, action: 'poll' | 'capture', injected?: ReturnType<typeof createRegistryService>) {
  return async (context: HandlerContext) => {
    const key = context.request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return { status: 422, body: { code: 'validation_failed' } };
    const actor = context.identity!.id;
    const digest = mutationHash('POST', context.route.path, context.body);
    try {
      return await repo.transaction(async tx => {
        const service = injected ?? createRegistryService({ ...tx, transaction: async (fn: any) => fn(tx) } as Repo);
        if (action === 'capture') {
          const input = context.body as z.infer<typeof Q.Capture>;
          if (input.telegram_user_id <= 0 || !input.press_id.trim()) return { status: 422, body: { code: 'validation_failed' } };
          if (!await tx.owners.byTelegramUserId(BigInt(input.telegram_user_id))) return { status: 403, body: { code: 'forbidden' } };
          if (await tx.registry.records.captureByPress(input.press_id)) return { status: 409, body: { code: 'press_replayed' } };
        }
        const claim = await tx.idempotencyKeys.claim({ actorId: actor, key, requestHash: digest, state: 'in_progress' });
        if (claim.replayed) {
          if (claim.row.requestHash !== digest) return { status: 409, body: { code: 'idempotency_conflict' } };
          if (action === 'capture' && await tx.registry.records.captureByPress((context.body as z.infer<typeof Q.Capture>).press_id)) return { status: 409, body: { code: 'press_replayed' } };
          if (claim.row.state !== 'done') return { status: 409, body: { code: 'idempotency_in_progress' } };
          return { status: claim.row.responseStatus!, body: claim.row.responseBody, headers: { 'Idempotent-Replay': 'true' } };
        }
        let status: number, body: unknown;
        if (action === 'poll') {
          const input = context.body as z.infer<typeof Q.RegistryPoll>;
          const result = await service.registerPoll({ type: 'relay' }, input.inquiry_id, { question: input.question, options: input.options, now: context.now });
          status = 201; body = { poll_id: result.pollId, display_line: result.displayLine };
        } else {
          const input = context.body as z.infer<typeof Q.Capture>;
          const row = await service.capturePoll({ type: 'relay' }, { pollId: input.poll_id, pressId: input.press_id, telegramUserId: input.telegram_user_id, optionIndex: input.option_index, now: context.now });
          status = 200; body = await registryRecord(tx, row);
        }
        await tx.idempotencyKeys.complete(actor, key, status, body);
        return { status, body };
      });
    } catch (error) {
      if (!(error instanceof RegistryRefusedError)) throw error;
      const status = error.reason === 'forbidden' ? 403 : error.reason === 'not_found' ? 404 : ['press_replayed', 'poll_closed'].includes(error.reason) ? 409 : 422;
      return { status, body: { code: error.reason } };
    }
  };
}

// GET /registry/drafts, registered once by registerRegistryHandlers. The cursor is a keyset position (creation time and
// number), so a page continues correctly after a draft on an earlier page was activated or removed.
export function draftsHandler(repo: Repo) {
  return async (context: HandlerContext) => {
    const params = new URL(context.request.url ?? '/', 'http://localhost').searchParams;
    if ([...params.keys()].some(key => !['limit', 'cursor'].includes(key) || params.getAll(key).length !== 1)) return { status: 422, body: { code: 'validation_failed' } };
    const { defaultLimit, maxLimit } = await pageLimits(repo);
    const rawLimit = params.get('limit');
    const size = rawLimit === null ? defaultLimit : Number(rawLimit);
    if ((rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) || !Number.isSafeInteger(size) || size > maxLimit) return { status: 422, body: { code: 'validation_failed' } };
    const rows = (await repo.registry.records.list({ status: 'draft' })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.number < b.number ? 1 : a.number > b.number ? -1 : 0));
    const cursor = params.get('cursor');
    let after: [string, string] | undefined;
    if (cursor !== null) {
      try {
        const bytes = Buffer.from(cursor, 'base64url');
        const decoded = z.tuple([z.iso.datetime(), z.string().regex(/^\d+$/)]).parse(JSON.parse(bytes.toString()));
        if (bytes.toString('base64url') !== cursor) throw new Error();
        after = decoded;
      } catch { return { status: 400, body: { code: 'bad_cursor' } }; }
    }
    const remaining = after ? rows.filter(row => row.createdAt.toISOString() < after![0] || (row.createdAt.toISOString() === after![0] && row.number < BigInt(after![1]))) : rows;
    const selected = remaining.slice(0, size);
    const items = await Promise.all(selected.map(row => registryRecord(repo, row)));
    const last = selected.at(-1);
    return { status: 200, body: { items, next_cursor: last && remaining.length > size ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), String(last.number)])).toString('base64url') : null } };
  };
}
