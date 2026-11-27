import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, apiRows, id, query, response, writeAudit } from './shared.ts';

export function registerWorkerHandlers(api: HandlerRegistrar, { repo, now = () => new Date(), queueGatewayEnabled = false }: HandlerDeps): void {
  api.register('GET', '/workers', async context => {
    const params = query(context);
    const rows = await repo.workers.list({ status: params.get('status') ?? undefined, platform: params.get('platform') ?? undefined });
    return response(200, { items: apiRows(rows), next_cursor: null });
  });
  api.register('GET', '/workers/{id}', async ({ params }) => {
    const row = await repo.workers.get(params.id);
    return row ? response(200, apiRow(row)) : response(404, { code: 'not_found' });
  });
  api.register('PATCH', '/workers/{id}', async context => {
    const { params, body } = context;
    const current = await repo.workers.get(params.id);
    if (!current) return response(404, { code: 'not_found' });
    const input = body as { status?: 'disabled' | 'online'; concurrency_limit?: number };
    const updated = await repo.transaction(async tx => {
      const row = await tx.workers.update(params.id, current.rowVersion, {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.concurrency_limit === undefined ? {} : { concurrencyLimit: input.concurrency_limit }),
      });
      if (row) await writeAudit(tx, context, 'worker.update', 'worker', row.id, 'ok', input);
      return row;
    });
    return updated ? response(200, apiRow(updated)) : response(409, { code: 'version_conflict' });
  });
  api.register('POST', '/workers/register', async context => {
    const input = context.body as { machine_id: string; name: string; platform: string; capabilities: unknown; version: string; contract_version: number };
    const known = await repo.workers.list();
    const existing = known.find(worker => worker.machineId === input.machine_id);
    // api.md:149, :676 and security.md:72 (T26): one machine only; a second one is refused with
    // 409 queue_isolation_required until the deployment declares the queue gateway (D28). Registering
    // an already known machine again is safe (api.md:149), so only a new machine is refused.
    const firstMachine = !known.some(worker => worker.machineId !== null);
    if (!existing && !firstMachine && !queueGatewayEnabled) return response(409, { code: 'queue_isolation_required' });
    const worker = await repo.transaction(async tx => {
      const registered = await tx.workers.register({
      id: existing?.id ?? id(), machineId: input.machine_id,
      name: input.name, platform: input.platform, capabilities: input.capabilities, version: input.version,
        // New workers default to one slot until an owner sets the documented concurrency limit.
        contractVersion: input.contract_version, status: 'online', concurrencyLimit: existing?.concurrencyLimit ?? 1,
      });
      await writeAudit(tx, context, 'worker.register', 'worker', registered.id, 'ok', { machine_id: input.machine_id });
      return registered;
    });
    return response(200, { worker_id: worker.id, contract_range: { min: String(worker.contractVersion), max: String(worker.contractVersion) } });
  });
  api.register('POST', '/workers/{id}/heartbeat', async context => {
    const { params, body, identity } = context;
    // api.md:150: a worker reports only for its own id.
    if (!identity || identity.workerId !== params.id) return response(403, { code: 'forbidden' });
    const input = body as { capabilities?: unknown; run_ids: string[] };
    const worker = await repo.transaction(async tx => {
      const updated = await tx.workers.heartbeat(params.id, input.capabilities, now());
      if (updated) await writeAudit(tx, context, 'worker.heartbeat', 'worker', updated.id, 'ok', { run_ids: input.run_ids });
      return updated;
    });
    if (!worker) return response(404, { code: 'not_found' });
    return response(200, { server_time: now().toISOString(), token_expires_at: identity.expiresAt?.toISOString() ?? null });
  });
}
