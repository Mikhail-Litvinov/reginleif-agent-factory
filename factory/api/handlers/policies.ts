import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, id, response, version, writeAudit } from './shared.ts';
import { loosenedColumns } from './policy-loosening.ts';
import { canonicalJson, requestHash, secondPress } from './second-press.ts';
import { confirmWindowSeconds } from './settings.ts';
import { StaleVersionError } from '../../db/repo/errors.ts';

export function registerPolicyHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
  api.register('GET', '/projects/{id}/policy', async ({ params }) => {
    const policy = await repo.policies.effective(params.id);
    return policy ? response(200, apiRow(policy)) : response(404, { code: 'not_found' });
  });
  api.register('PUT', '/projects/{id}/policy', async context => {
    const { params, body, identity } = context;
    if (!await repo.projects.get(params.id)) return response(404, { code: 'not_found' });
    const input = body as Record<string, unknown>;
    // api.md PolicyPut: If-Match is the version number being replaced; a project without a policy of its own is at 0.
    if (!context.request.headers['if-match']) return response(422, { code: 'validation_failed' });
    const expected = version(context);
    if (expected === undefined) return response(422, { code: 'validation_failed' });
    const actorId = identity?.ownerId ?? identity?.id ?? null;
    if (!actorId) return response(403, { code: 'forbidden' });
    const windowSeconds = await confirmWindowSeconds(repo);
    return repo.transaction(async tx => {
      const effective = await tx.policies.effective(params.id);
      const own = effective && effective.projectId === params.id ? effective : undefined;
      if (BigInt(own?.version ?? 0) !== expected) throw new StaleVersionError(["policy", params.id].join(" "), expected, BigInt(own?.version ?? 0));
      // database.md: a change that loosens a security column or raises a limit takes the second press (D23).
      const loosened = loosenedColumns(effective ? apiRow(effective) : undefined, input);
      if (loosened.length > 0) {
        const hash = requestHash(canonicalJson({ method: 'PUT', path: `/projects/${params.id}/policy`, if_match: String(expected), body: input }));
        const press = await secondPress(tx, context, { actorId,operation: 'policy_loosen', targetType: 'project', targetId: params.id, requestHash: hash, now: now(), windowSeconds });
        if (press) return press;
      }
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
        createdBy: actorId,
      });
      await writeAudit(tx, context, loosened.length > 0 ? 'policy.loosen' : 'policy.create', 'project', params.id, 'ok', { project_id: params.id, version: created.version, ...(loosened.length > 0 ? { loosened } : {}) });
      return response(201, apiRow(created), { location: `/projects/${params.id}/policy` });
    });
  });
}
