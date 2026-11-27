import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { response } from './shared.ts';
import { checkForSubject, type Right } from '../../rights/check.ts';

function parseCall(action: string, target: unknown): Right | undefined {
  if (typeof target === 'string') return { action, target, conditions: {} };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const value = target as Record<string, unknown>;
  if (typeof value.target !== 'string' || !Object.hasOwn(value, 'conditions') || Object.keys(value).some(key => key !== 'target' && key !== 'conditions')) return undefined;
  return { action, target: value.target, conditions: value.conditions };
}

export function registerRightsHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
  api.register('POST', '/rights/check', async context => {
    const input = context.body as { run_id?: string; session_id?: string; task_id?: string; action: string; target: unknown };
    return repo.transaction(async tx => {
      const identity = context.identity;
      if (!identity) return response(403, { code: 'forbidden' });
      const token = await tx.tokens.get(identity.id);
      if (!token) return response(403, { code: 'forbidden' });
      if (identity.role === 'registry' && (input.run_id ? token.runId !== input.run_id : token.sessionRef !== input.session_id)) return response(403, { code: 'forbidden' });
      let taskId: string | null = null, projectId: string | null = null, participant: string | null = null, agentId: string | null = null;
      if (input.run_id) {
        const run = await tx.taskReads.getRun(input.run_id);
        if (!run) return response(404, { code: 'not_found' });
        if (identity.role === 'worker' && run.workerId !== identity.workerId) return response(403, { code: 'forbidden' });
        if (input.task_id && input.task_id !== run.taskId) return response(403, { code: 'forbidden' });
        const task = await tx.tasks.get(run.taskId);
        if (!task) return response(404, { code: 'not_found' });
        taskId = run.taskId; projectId = task.projectId; participant = run.participant; agentId = run.agentId;
      } else {
        if (identity.role !== 'registry' || !input.session_id || input.task_id) return response(403, { code: 'forbidden' });
        const conversation = await tx.conversations.bySessionRef(input.session_id);
        projectId = conversation?.projectId ?? null;
        const runs = await tx.taskReads.runsForSession(input.session_id);
        const agents = [...new Set(runs.map(run => run.agentId).filter((id): id is string => id !== null))];
        if (agents.length > 1) return response(403, { code: 'forbidden' });
        agentId = agents[0] ?? null;
      }
      const call = parseCall(input.action, input.target);
      const result = await checkForSubject(tx, { projectId, taskId, participant, agentId, sessionRef: input.session_id ?? null }, call, now());
      return response(200, result);
    });
  });
}
