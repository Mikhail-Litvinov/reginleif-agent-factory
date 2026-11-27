import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, apiRows, id, query, response, version, writeAudit } from './shared.ts';

export function registerAgentHandlers(api: HandlerRegistrar, { repo }: HandlerDeps): void {
  api.register('GET', '/agents', async context => {
    const params = query(context);
    const rows = await repo.agents.list({
      includeDeleted: context.identity?.role === 'owner' && params.get('include_deleted') === 'true',
      provider: params.get('provider') ?? undefined,
      enabled: params.has('enabled') ? params.get('enabled') === 'true' : undefined,
    });
    return response(200, { items: apiRows(rows), next_cursor: null });
  });
  api.register('GET', '/agents/{id}', async ({ params, identity }) => {
    const row = await repo.agents.get(params.id, { includeDeleted: identity?.role === 'owner' });
    return row ? response(200, apiRow(row)) : response(404, { code: 'not_found' });
  });
  api.register('POST', '/agents', async context => {
    const { body } = context;
    const input = body as Record<string, unknown>;
    const row = await repo.transaction(async tx => {
      const created = await tx.agents.create({
        id: id(), name: input.name as string, provider: input.provider as string, adapterType: input.adapter_type as string,
        // An omitted limit starts with one concurrent run; the owner can raise it explicitly later.
        capabilities: input.capabilities ?? {}, enabled: (input.enabled as boolean | undefined) ?? true, concurrencyLimit: (input.concurrency_limit as number | undefined) ?? 1,
        configuration: input.configuration ?? {},
      });
      await writeAudit(tx, context, 'agent.create', 'agent', created.id, 'ok', { name: input.name, provider: input.provider });
      return created;
    });
    return response(201, apiRow(row), { location: `/agents/${row.id}` });
  });
  api.register('PATCH', '/agents/{id}', async context => {
    const expected = version(context);
    if (expected === undefined) return response(422, { code: 'validation_failed' });
    const input = context.body as Record<string, unknown>;
    const row = await repo.transaction(async tx => {
      const updated = await tx.agents.update(context.params.id, expected, {
      ...(input.name === undefined ? {} : { name: input.name as string }),
      ...(input.provider === undefined ? {} : { provider: input.provider as string }),
      ...(input.adapter_type === undefined ? {} : { adapterType: input.adapter_type as string }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
      ...(input.concurrency_limit === undefined ? {} : { concurrencyLimit: input.concurrency_limit as number }),
      ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
      });
      if (updated) await writeAudit(tx, context, 'agent.update', 'agent', updated.id, 'ok', input);
      return updated;
    });
    return row ? response(200, apiRow(row)) : response(409, { code: 'version_conflict' });
  });
  api.register('DELETE', '/agents/{id}', async context => {
    const expected = version(context);
    if (expected === undefined) return response(422, { code: 'validation_failed' });
    const row = await repo.transaction(async tx => {
      const deleted = await tx.agents.softDelete(context.params.id, expected);
      if (deleted) await writeAudit(tx, context, 'agent.delete', 'agent', deleted.id, 'ok', null);
      return deleted;
    });
    return row ? response(200, apiRow(row)) : response(409, { code: 'version_conflict' });
  });
}
