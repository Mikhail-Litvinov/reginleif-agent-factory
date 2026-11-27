import { readStreamPage, streamSource } from '../cursor.ts';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRows, positiveInt, query, response } from './shared.ts';
import { pageLimits } from './settings.ts';

export function registerEventHandlers(api: HandlerRegistrar, { repo }: HandlerDeps): void {
  api.register('GET', '/tasks/{id}/events', async context => {
    if (!await repo.tasks.get(context.params.id)) return response(404, { code: 'not_found' });
    const params = query(context);
    const limits = await pageLimits(repo);
    const limit = positiveInt(params.get('limit'), limits.defaultLimit, limits.maxLimit);
    const page = await readStreamPage('task_events', streamSource(repo, 'task_events', {
      taskId: context.params.id, runId: params.get('run_id') ?? undefined, type: params.get('type') ?? undefined,
    }), { cursor: params.get('cursor') ?? undefined, limit });
    return response(200, { items: apiRows(page.items), next_cursor: page.next_cursor });
  });
  // GET /events/stream is owned by the client handlers (api/handlers/client.ts), the live stream.
}
