import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, id, response, writeAudit } from './shared.ts';

export function registerPolicyHandlers(api: HandlerRegistrar, { repo }: HandlerDeps): void {
  api.register('GET', '/projects/{id}/policy', async ({ params }) => {
    const policy = await repo.policies.effective(params.id);
    return policy ? response(200, apiRow(policy)) : response(404, { code: 'not_found' });
  });
  api.register('PUT', '/projects/{id}/policy', async context => {
    const { params, body, identity } = context;
    if (!await repo.projects.get(params.id)) return response(404, { code: 'not_found' });
    const input = body as Record<string, unknown>;
    const row = await repo.transaction(async tx => {
      const created = await tx.policies.create({
      id: id(), projectId: params.id,
      allowedCommands: input.allowed_commands as string[], allowedDirectories: input.allowed_directories as string[],
      allowedRepositories: input.allowed_repositories as string[], network: input.network, gitOperations: input.git_operations as string[],
      confirmationRequired: input.confirmation_required as string[], allowedTools: input.allowed_tools as string[],
      maxConcurrentTasks: input.max_concurrent_tasks as number | null, maxTasksPerAgent: input.max_tasks_per_agent as number | null,
      maxRunSeconds: input.max_run_seconds as number | null, maxTokens: input.max_tokens as number | null,
      maxCost: input.max_cost as string | null, currency: input.currency as string | null,
      maxAutoFixes: input.max_auto_fixes as number | null, maxAttempts: input.max_attempts as number | null,
      maxReworkRounds: input.max_rework_rounds as number | null, maxChildDepth: input.max_child_depth as number | null,
      maxChildrenPerTask: input.max_children_per_task as number | null, autoAcceptLowRisk: input.auto_accept_low_risk as boolean,
      createdBy: identity?.ownerId ?? identity?.id ?? null,
      });
      await writeAudit(tx, context, 'policy.create', 'project', params.id, 'ok', { project_id: params.id });
      return created;
    });
    return response(201, apiRow(row), { location: `/projects/${params.id}/policy` });
  });
}
