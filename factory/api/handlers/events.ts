import { decodeCursor, encodeCursor, readStreamPage, streamSource, type Stream } from '../cursor.ts';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRows, positiveInt, query, response } from './shared.ts';
import { pageLimits } from './settings.ts';

export function registerEventHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
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
  api.register('GET', '/events/stream', async context => {
    const params = query(context);
    const cursors = params.getAll('cursor');
    const last = context.request.headers['last-event-id'];
    if (typeof last === 'string') cursors.push(last);
    const starts = new Map<Stream, string>();
    for (const cursor of cursors) {
      const stream = (['task_events', 'audit_log', 'notifications', 'messages'] as const).find(candidate => {
        try { decodeCursor(candidate, cursor); return true; } catch { return false; }
      });
      if (!stream) return response(400, { code: 'bad_cursor' });
      starts.set(stream, cursor);
    }
    const limits = await pageLimits(repo);
    const limit = limits.defaultLimit;
    const output: string[] = [];
    const streams: Stream[] = starts.size ? [...starts.keys()] : ['task_events', 'audit_log', 'notifications', 'messages'];
    for (const stream of streams) {
      const page = await readStreamPage(stream, streamSource(repo, stream), { cursor: starts.get(stream), limit });
      for (const item of page.items) {
        output.push(`id: ${encodeCursor(stream, item)}\nevent: ${stream}\ndata: ${JSON.stringify(apiRows([item])[0])}\n\n`);
      }
    }
    return response(200, output.join(''), { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-server-time': now().toISOString() });
  });
}
