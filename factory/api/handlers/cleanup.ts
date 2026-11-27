import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { query, response } from './shared.ts';
import { confirmWindowSeconds } from './settings.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function registerCleanupHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
  api.register('POST', '/tasks/{id}/cleanup', async context => {
    const params = query(context);
    const dryRun = params.get('dry_run') !== 'false';
    const force = params.get('force') === 'true';
    const task = await repo.tasks.get(context.params.id);
    if (!task || task.originType === 'standing') return response(404, { code: 'not_found' });
    const final = ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED'].includes(task.status ?? '');
    if (!final) return response(409, { code: 'task_active' });
    const items = await repo.tasks.cleanupItems(task.id);
    if (dryRun) return response(200, { dry_run: true, items, total_size: items.reduce((sum, item) => sum + (item.size ?? 0), 0) });

    const target = `POST /tasks/${task.id}/cleanup?dry_run=false&force=${force}`;
    const requestHash = hash(target);
    const keyHeader = context.request.headers['idempotency-key'];
    const key = typeof keyHeader === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(keyHeader) ? keyHeader : undefined;
    const actorId = context.identity?.ownerId ?? context.identity?.id;
    if (!key) return response(422, { code: 'validation_failed' });
    if (!actorId) return response(403, { code: 'forbidden' });
    if (force) {
      const confirmHeader = context.request.headers['x-confirm'];
      if (typeof confirmHeader !== 'string') {
        const id = randomUUID();
        const nonce = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now().getTime() + await confirmWindowSeconds(repo) * 1000);
        await repo.confirmations.create({ id, actorId, channel: 'api', deviceSessionId: null, operation: 'cleanup', targetType: 'task', targetId: task.id, requestHash, nonceHash: hash(nonce), issuedAt: now(), expiresAt });
        return response(409, { code: 'confirmation_required', confirmation_id: id, nonce, expires_at: expiresAt.toISOString() });
      }
      const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i.exec(confirmHeader);
      if (!match) return response(409, { code: 'confirmation_invalid' });
      const confirmation = await repo.confirmations.get(match[1]!);
      const expected = confirmation?.nonceHash;
      const actual = hash(match[2]!);
      const nonceMatches = !!expected && expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
      if (!nonceMatches || !await repo.confirmations.consume({ id: match[1]!, actorId, channel: 'api', deviceSessionId: null, operation: 'cleanup', targetType: 'task', targetId: task.id, requestHash, now: now() })) return response(409, { code: 'confirmation_invalid' });
    }

    const outboxId = randomUUID();
    const result = await repo.transaction(async tx => {
      const claim = await tx.idempotencyKeys.claim({ actorId, key, requestHash, state: 'in_progress' });
      if (claim.replayed) {
        if (claim.row.requestHash !== requestHash) return { error: 'idempotency_conflict' as const };
        if (claim.row.state !== 'done') return { error: 'idempotency_in_progress' as const };
        return { replay: claim.row.responseBody as { id: string; delivery_state: string } };
      }
      await tx.taskEvents.persist({ id: randomUUID(), taskId: task.id, runId: null, eventType: 'cleanup_requested', actorType: 'owner', actorId: context.identity?.ownerId ?? null, payload: { force }, correlationId: context.requestId, dedupeKey: context.requestId });
      await tx.outbox.create({ id: outboxId, kind: 'cleanup', taskId: task.id, decisionId: null, payload: { task_id: task.id, force }, state: 'pending', attempts: 0 });
      await tx.audit.append({ id: randomUUID(), actorId: context.identity?.ownerId ?? null, tokenId: context.identity?.id ?? null, deviceSessionId: null, requestId: context.requestId, action: 'task.cleanup', targetType: 'task', targetId: task.id, outcome: 'ok', requestHash, details: { route: '/tasks/{id}/cleanup' } });
      const body = { id: outboxId, delivery_state: 'recorded' };
      await tx.idempotencyKeys.complete(actorId, key, 202, body);
      return { body };
    });
    if ('error' in result) return response(409, { code: result.error });
    const body = 'replay' in result ? result.replay : result.body;
    return response(202, body, { location: `/tasks/${task.id}/cleanup`, ...('replay' in result ? { 'Idempotent-Replay': 'true' } : {}) });
  });
}
