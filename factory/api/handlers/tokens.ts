import { createHash } from 'node:crypto';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, id, response, secretToken, writeAudit } from './shared.ts';
import { tokenOverlapSeconds } from './settings.ts';
import { RepositoryNotFoundError } from '../../db/repo/errors.ts';

const requestDigest = (method: string, path: string, body: unknown) => createHash('sha256').update(JSON.stringify([method, path, body])).digest('hex');
const idempotencyKey = (context: { request: { headers: Record<string, string | string[] | undefined> } }) => {
  const value = context.request.headers['idempotency-key'];
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;
};

export function registerTokenHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
  api.register('GET', '/tokens', async () => response(200, { items: (await repo.tokens.list()).map(apiRow), next_cursor: null }));
  api.register('POST', '/tokens', async context => {
    const { body, identity } = context;
    const input = body as { name: string; role: string; worker_id?: string; owner_id?: string; session_ref?: string; run_id?: string; expires_at?: string };
    const key = idempotencyKey(context);
    if (!key) return response(422, { code: 'validation_failed' });
    const secret = secretToken();
    const actorId = identity?.ownerId ?? identity?.id ?? null;
    if (!actorId) return response(403, { code: 'forbidden' });
    const ownerId = input.role === 'owner' ? actorId : null;
    const workerId = input.role === 'worker' ? input.worker_id : null;
    if ((input.role === 'worker' && !workerId) || (input.role === 'registry' && Boolean(input.session_ref) === Boolean(input.run_id))) return response(422, { code: 'validation_failed' });
    if (workerId && !await repo.workers.get(workerId)) return response(422, { code: 'validation_failed' });
    const requestHash = requestDigest(context.request.method ?? 'POST', context.route.path, input);
    const result = await repo.transaction(async tx => {
      const claim = await tx.idempotencyKeys.claim({ actorId, key, requestHash, state: 'in_progress' });
      if (claim.replayed) {
        if (claim.row.requestHash !== requestHash) return { error: 'idempotency_conflict' as const };
        return { error: claim.row.state === 'done' ? 'token_already_issued' as const : 'idempotency_in_progress' as const };
      }
      const created = await tx.tokens.create({ id: id(), name: input.name, role: input.role, ownerId, workerId,
        sessionRef: input.session_ref ?? null, runId: input.run_id ?? null, prefix: secret.prefix, tokenHash: secret.tokenHash,
        createdBy: actorId, expiresAt: input.expires_at ? new Date(input.expires_at) : null });
      await writeAudit(tx, context, 'token.create', 'token', created.id, 'ok', { name: input.name, role: input.role, worker_id: workerId });
      await tx.idempotencyKeys.complete(actorId, key, 201, { token_id: created.id });
      return { created };
    });
    if ('error' in result) return response(409, { code: result.error });
    return response(201, { ...apiRow(result.created), secret: `afk_${secret.prefix}_${secret.secret}` }, { location: `/tokens/${result.created.id}` });
  });
  api.register('POST', '/tokens/{id}/rotate', async context => {
    const { params, identity } = context;
    const key = idempotencyKey(context);
    if (!key) return response(422, { code: 'validation_failed' });
    const raw = await repo.tokens.get(params.id);
    if (!raw || raw.revokedAt) return response(404, { code: 'not_found' });
    const secret = secretToken();
    const overlapSeconds = await tokenOverlapSeconds(repo);
    const validUntil = new Date(now().getTime() + overlapSeconds * 1000);
    const actorId = identity?.ownerId ?? identity?.id;
    if (!actorId) return response(403, { code: 'forbidden' });
    const requestHash = requestDigest(context.request.method ?? 'POST', `${context.route.path}:${params.id}`, null);
    const result = await repo.transaction(async tx => {
      const claim = await tx.idempotencyKeys.claim({ actorId, key, requestHash, state: 'in_progress' });
      if (claim.replayed) {
        if (claim.row.requestHash !== requestHash) return { error: 'idempotency_conflict' as const };
        return { error: claim.row.state === 'done' ? 'token_already_issued' as const : 'idempotency_in_progress' as const };
      }
      const replacement = await tx.tokens.rotate(params.id, raw.rowVersion, {
        id: id(), name: raw.name, role: raw.role, ownerId: raw.ownerId, workerId: raw.workerId, sessionRef: raw.sessionRef,
        runId: raw.runId, prefix: secret.prefix, tokenHash: secret.tokenHash, createdBy: identity?.ownerId ?? identity?.id ?? raw.createdBy,
        expiresAt: raw.expiresAt,
      }, validUntil);
      if (replacement) await writeAudit(tx, context, 'token.rotate', 'token', replacement.id, 'ok', { replaces_token_id: params.id });
      if (!replacement) throw new RepositoryNotFoundError(["token", params.id].join(" "));
      await tx.idempotencyKeys.complete(actorId, key, 201, { token_id: replacement.id });
      return { replacement };
    });
    if ('error' in result) return response(409, { code: result.error });
    return response(201, { ...apiRow(result.replacement), secret: `afk_${secret.prefix}_${secret.secret}` }, { location: `/tokens/${result.replacement.id}` });
  });
  api.register('DELETE', '/tokens/{id}', async context => {
    const { params } = context;
    const key = idempotencyKey(context);
    if (!key) return response(422, { code: 'validation_failed' });
    const actorId = context.identity?.ownerId ?? context.identity?.id;
    if (!actorId) return response(403, { code: 'forbidden' });
    const requestHash = requestDigest(context.request.method ?? 'DELETE', `${context.route.path}:${params.id}`, null);
    const raw = await repo.tokens.get(params.id);
    if (!raw) return response(404, { code: 'not_found' });
    const result = await repo.transaction(async tx => {
      const claim = await tx.idempotencyKeys.claim({ actorId, key, requestHash, state: 'in_progress' });
      if (claim.replayed) {
        if (claim.row.requestHash !== requestHash) return { error: 'idempotency_conflict' as const };
        if (claim.row.state !== 'done') return { error: 'idempotency_in_progress' as const };
        return { replay: claim.row.responseBody as Record<string, unknown> };
      }
      const revoked = await tx.tokens.revoke(params.id, raw.rowVersion);
      if (!revoked) throw new RepositoryNotFoundError(["token", params.id].join(" "));
      await writeAudit(tx, context, 'token.revoke', 'token', revoked.id, 'ok', null);
      const body = apiRow(revoked);
      await tx.idempotencyKeys.complete(actorId, key, 200, body);
      return { revoked: body };
    });
    if ('error' in result) return response(409, { code: result.error });
    return response(200, 'replay' in result ? result.replay : result.revoked, 'replay' in result ? { 'Idempotent-Replay': 'true' } : undefined);
  });
}
