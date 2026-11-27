import { readStreamPage, streamSource } from '../cursor.ts';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRows, positiveInt, query, response } from './shared.ts';
import { pageLimits } from './settings.ts';

export function registerAuditHandlers(api: HandlerRegistrar, { repo }: HandlerDeps): void {
  api.register('GET', '/system/audit', async context => {
    const params = query(context);
    const limits = await pageLimits(repo);
    const page = await readStreamPage('audit_log', streamSource(repo, 'audit_log', {
      actorId: params.get('actor_id') ?? undefined, action: params.get('action') ?? undefined,
      targetId: params.get('target_id') ?? undefined,
    }), { cursor: params.get('cursor') ?? undefined, limit: positiveInt(params.get('limit'), limits.defaultLimit, limits.maxLimit) });
    return response(200, { items: apiRows(page.items), next_cursor: page.next_cursor });
  });
}
