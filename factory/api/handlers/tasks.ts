import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskRequestSchema, decisionRequestSchemas, taskStateSchema } from '../../contracts/schemas/index.ts';
import { projectCreateSchema, projectPatchSchema, projectSchema, routingRuleCreateSchema, routingRuleSchema, executionPolicySchema } from '../../contracts/schemas/projects.ts';
import * as resource from '../../contracts/schemas/resources.ts';
import { DependencyCreate } from '../../contracts/schemas/requests.ts';
import { routes } from '../../contracts/routes.ts';
import { phaseTwoBlockKinds } from '../../contracts/states.ts';
import { driverError } from '../../db/repo/errors.ts';
import type { Repo } from '../../db/repo/index.ts';
import { DependencyRefusedError, TaskDeleteRefusedError } from '../../db/repo/tasks.ts';
import { DecisionProblem, recordDecision, requestFingerprint, type DecisionKind } from '../decisions.ts';
import type { createApiServer, Handler, HandlerContext } from '../server.ts';

type Api = ReturnType<typeof createApiServer>;
type Result = Awaited<ReturnType<Handler>>;
type Transaction = Parameters<Parameters<Repo['transaction']>[0]>[0];
const uuid = z.uuid();
const int = z.string().regex(/^-?\d+$/).transform(Number).pipe(z.int32());
const positive = int.pipe(z.number().int().positive());
const bool = z.enum(['true', 'false']).transform(value => value === 'true');
const date = z.iso.datetime({ offset: true }).transform(value => new Date(value));
const versionLimit = 9223372036854775807n; // PostgreSQL bigint
const origins = z.enum(['owner', 'decomposition', 'agent_proposal', 'continuation', 'standing']);
const finalStates = new Set(['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED']);
const fallback = { 'page.default': 50, 'page.max': 200, 'confirm.windowSeconds': 60 } as const;

const fail = (code: string, status: number): never => { throw new DecisionProblem(code, status); };
const validate = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : fail('validation_failed', 422);
};
const found = <T>(row: T | undefined | null): T => row ?? fail('not_found', 404);
const id = (context: HandlerContext, name = 'id') => validate(uuid, context.params[name]).toLowerCase();
const header = ({ request }: HandlerContext, name: string) => typeof request.headers[name] === 'string' ? request.headers[name] : undefined;
const pathname = ({ request }: HandlerContext) => new URL(request.url!, 'http://localhost').pathname;
const sessionId = ({ identity }: HandlerContext) => identity?.role === 'device' ? identity.id : null;
const actorId = ({ identity }: HandlerContext) => identity?.ownerId ?? fail('forbidden', 403);
const json = (status: number, body: unknown, headers?: Record<string, string>): Result => ({ status, body, headers });
const created = (body: unknown, location: string) => json(201, body, { Location: location });
const conflict = (current: bigint, code = 'version_conflict') => json(409, { code, current_row_version: Number(current) });
const canReadDeleted = ({ identity }: HandlerContext) => identity?.role === 'owner' || identity?.role === 'device';

// Project only the contract columns. JSON fields keep their original keys.
function wire(schema: z.ZodObject, row: object, overrides: Record<string, unknown> = {}) {
  const data = row as Record<string, unknown>;
  return Object.fromEntries(Object.keys(schema.shape).map(key => {
    const property = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const value = Object.hasOwn(overrides, key) ? overrides[key] : data[property];
    return [key, value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value];
  }));
}

function listQuery<S extends z.ZodRawShape>(context: HandlerContext, shape: S) {
  const search = new URL(context.request.url!, 'http://localhost').searchParams;
  const values: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    if (key !== 'status' || context.route.path !== '/tasks') {
      if (all.length !== 1) fail('validation_failed', 422);
      values[key] = all[0]!;
    } else values[key] = all;
  }
  const query = validate(z.strictObject({ ...shape, limit: positive.optional(), cursor: z.string().optional(), include_deleted: bool.optional() }), values) as
    z.output<z.ZodObject<S>> & PageQuery & { include_deleted?: boolean };
  if (query.include_deleted && !canReadDeleted(context)) fail('forbidden', 403);
  return query;
}

async function setting(repo: Repo, key: keyof typeof fallback) {
  const value = (await repo.settings.snapshot([key]))[key];
  if (value === undefined) return fallback[key];
  return z.number().int().positive().parse(value);
}

type SortKey = string | number;
type PageQuery = { limit?: number; cursor?: string };
async function page<T extends { id: string }>(repo: Repo, context: HandlerContext, query: PageQuery, rows: T[],
  key: (row: T) => SortKey, type: 'string' | 'number', convert: (row: T) => unknown, direction: 'asc' | 'desc' = 'asc') {
  const maximum = await setting(repo, 'page.max');
  const limit = query.limit ?? Math.min(maximum, await setting(repo, 'page.default'));
  if (limit > maximum) fail('validation_failed', 422);
  const filters = new URL(context.request.url!, 'http://localhost').searchParams;
  filters.delete('limit');
  filters.delete('cursor');
  filters.sort();
  const scope = requestFingerprint('GET', pathname(context), [filters.toString(), context.identity?.id]);
  const compareValue = (left: SortKey, right: SortKey) => left < right ? -1 : left > right ? 1 : 0;
  const compare = (left: [SortKey, string], right: [SortKey, string]) =>
    compareValue(left[0], right[0]) * (direction === 'asc' ? 1 : -1) || compareValue(left[1], right[1]);
  const position = (row: T): [SortKey, string] => [key(row), row.id];
  let after: [SortKey, string] | undefined;
  if (query.cursor !== undefined) {
    try {
      const buffer = Buffer.from(query.cursor, 'base64url');
      if (buffer.toString('base64url') !== query.cursor) fail('bad_cursor', 400);
      const decoded = z.tuple([z.literal(scope), type === 'number' ? z.number() : z.string(), uuid]).parse(JSON.parse(buffer.toString('utf8')));
      after = [decoded[1], decoded[2]];
    } catch { fail('bad_cursor', 400); }
  }
  const results = rows.filter(row => !after || compare(position(row), after) > 0).sort((a, b) => compare(position(a), position(b))).slice(0, limit + 1);
  const items = results.slice(0, limit);
  const next_cursor = results.length > limit ? Buffer.from(JSON.stringify([scope, ...position(items.at(-1)!)])).toString('base64url') : null;
  return json(200, { items: items.map(convert), next_cursor });
}

function ifMatch(context: HandlerContext, current?: bigint) {
  const match = /^(?:"([1-9]\d{0,18})"|([1-9]\d{0,18}))$/.exec(header(context, 'if-match') ?? '');
  if (!match && current !== undefined && header(context, 'if-match') === undefined) return current;
  if (!match) return fail('validation_failed', 422);
  const version = BigInt(match[1] ?? match[2]!);
  return version <= versionLimit ? version : fail('validation_failed', 422);
}

function auditOf(context: HandlerContext, principal: string | undefined, requestHash: string, outcome: 'ok' | 'failed' | 'denied', targetId?: string) {
  return { id: randomUUID(), actorId: principal, tokenId: context.identity?.id, deviceSessionId: sessionId(context),
    requestId: context.requestId, action: `${context.route.method} ${context.route.path}`, targetType: context.route.path.split('/')[1],
    targetId, requestHash, outcome };
}

function mutation(repo: Repo, operation: (context: HandlerContext, tx: Transaction, actor: string) => Promise<Result>): Handler {
  return context => repo.transaction(async tx => {
    const actor = actorId(context);
    const key = header(context, 'idempotency-key') ?? '';
    const parameter = context.route.parameters.find(parameter => parameter.name === 'Idempotency-Key')!;
    validate(parameter.schema!, key);
    const hash = requestFingerprint(context.route.method, pathname(context), context.body);
    if (!await tx.decisions.tryLockKey(actor, key)) fail('idempotency_in_progress', 409);
    if (await tx.decisions.byActorKey(actor, key)) fail('idempotency_conflict', 409);
    const previous = await tx.idempotencyKeys.get(actor, key);
    if (previous) {
      if (previous.requestHash !== hash) fail('idempotency_conflict', 409);
      if (previous.state !== 'done') return json(409, { code: 'idempotency_in_progress', retry_after: 1 }, { 'Retry-After': '1' });
      const result = previous.responseBody as Result;
      const targetId = context.params.id ? id(context) : (result.body as { id?: string })?.id;
      await tx.audit.append(auditOf(context, actor, hash, 'ok', targetId));
      return { ...result, headers: { ...result.headers, 'Idempotent-Replay': 'true' } };
    }
    const result = await operation(context, tx, actor);
    if (result.status >= 400) return result;
    // Persist the answer and its Location with the mutation, so a retry cannot repeat the effect.
    await tx.idempotencyKeys.claim({ actorId: actor, key, requestHash: hash, state: 'in_progress' });
    await tx.idempotencyKeys.complete(actor, key, result.status, result);
    const targetId = context.params.id ? id(context) : (result.body as { id?: string })?.id;
    await tx.audit.append(auditOf(context, actor, hash, 'ok', targetId));
    return result;
  });
}

const sendProject = (row: Awaited<ReturnType<Repo['projects']['create']>>) => wire(projectSchema, row, {
  description: row.description ?? '', repository_url: row.repositoryUrl ?? '', default_branch: row.defaultBranch ?? '',
  workspace_policy: row.workspacePolicy ?? 'worktree', settings: row.settings ?? {}, priority: row.priority ?? 0,
});
const sendTask = (row: NonNullable<Awaited<ReturnType<Repo['tasks']['get']>>>) => wire(resource.Task, row, {
  description: row.description ?? '', title: row.title ?? '', priority: row.priority ?? 0, current_revision: row.currentRevision ?? 1,
  origin_type: row.originType ?? 'owner', pause_requested: row.pauseRequested ?? false, stopping: row.stopping ?? false,
  end_unconfirmed: row.endUnconfirmed ?? false,
});
const sendDecision = (row: NonNullable<Awaited<ReturnType<Repo['decisions']['get']>>>) => wire(resource.TaskDecision, row);

async function taskAt(repo: Transaction, taskId: string, includeDeleted = false, lock = false) {
  const row = found(await repo.tasks.get(taskId, { includeDeleted, lock }));
  if (!row.projectId || !await repo.projects.get(row.projectId, { includeDeleted })) fail('not_found', 404);
  return row;
}

async function taskDetail(repo: Transaction, row: Awaited<ReturnType<typeof taskAt>>) {
  const revision = await repo.tasks.getRevision(row.id, row.currentRevision ?? 1);
  const dependencies = await repo.tasks.dependencies(row.id);
  const pending = (await repo.decisions.listForTask(row.id)).filter(entry => entry.deliveryState === 'recorded' || entry.deliveryState === 'delivering');
  return { ...sendTask(row), revision: revision ? wire(resource.TaskRevision, revision) : null,
    dependencies: dependencies.map(edge => wire(resource.TaskDependency, edge)), pending_decisions: pending.map(entry => ({
      id: entry.id, kind: entry.kind, delivery_state: entry.deliveryState, refusal_reason: entry.refusalReason,
    })) };
}

async function addDependency(tx: Transaction, taskId: string, dependsOnId: string, type: 'requires_accepted') {
  const target = found(await tx.tasks.get(dependsOnId));
  if (target.originType === 'standing') fail('validation_failed', 422);
  try { return await tx.tasks.addDependency(taskId, dependsOnId, type); }
  catch (error) {
    if (error instanceof DependencyRefusedError && error.reason === 'dependency_cycle') fail('dependency_cycle', 409);
    if (error instanceof DependencyRefusedError || driverError(error)?.code === '23505') fail('validation_failed', 422);
    throw error;
  }
}

export function registerTasks(api: Api, repo: Repo, { clock = () => new Date(), contractVersion = 1 } = {}) {
  const register = (method: Parameters<Api['register']>[0], path: string, handler: Handler,
    authorizeScope?: NonNullable<Parameters<Api['register']>[3]>['authorizeScope']) => api.register(method, path, async context => {
    const respond = async (): Promise<Result> => {
      try {
        const query = new URL(context.request.url!, 'http://localhost').searchParams;
        if ([...query.keys()].some(name => !context.route.parameters.some(parameter => parameter.in === 'query' && parameter.name === name))) {
          fail('validation_failed', 422);
        }
        return await handler(context);
      }
      catch (error) {
        if (error instanceof DecisionProblem) {
          const retry = error.code === 'idempotency_in_progress';
          return json(error.status, { code: error.code, current_row_version: error.currentRowVersion, ...(retry ? { retry_after: 1 } : {}) }, retry ? { 'Retry-After': '1' } : undefined);
        }
        const code = driverError(error)?.code;
        if (code === '22003' || code === '22P02') return json(422, { code: 'validation_failed' });
        throw error;
      }
    };
    const result = await respond();
    if (result.status >= 400) return result;
    const schema = context.route.responses[result.status];
    if (!(schema instanceof z.ZodType)) throw new Error('Missing route response schema');
    return { ...result, body: schema.parse(result.body), headers: { 'Content-Type': 'application/json', ...result.headers } };
  }, { authorizeScope, onProblem: async (context, status, code) => {
    if (context.route.method === 'GET' || code === 'confirmation_required') return;
    const targetId = uuid.safeParse(context.params.id);
    const hash = requestFingerprint(context.route.method, pathname(context), context.body);
    await repo.audit.append({ ...auditOf(context, context.identity?.ownerId ?? undefined, hash,
      status === 401 || status === 403 ? 'denied' : 'failed', targetId.success ? targetId.data : undefined), details: { code } });
  } });

  register('GET', '/projects', async context => {
    const query = listQuery(context, { archived: bool.optional(), q: z.string().optional() });
    const rows = await repo.projects.list({ includeDeleted: query.include_deleted, archived: query.archived, q: query.q });
    return page(repo, context, query, rows, row => row.name ?? '', 'string', sendProject);
  });
  register('POST', '/projects', mutation(repo, async (context, tx, actor) => {
    const body = projectCreateSchema.parse(context.body);
    const projectId = randomUUID();
    let row;
    try { row = await tx.projects.create({ id: projectId, name: body.name, repositoryUrl: body.repository_url,
      description: body.description ?? '', defaultBranch: body.default_branch ?? '', workspacePolicy: body.workspace_policy ?? 'worktree',
      settings: body.settings ?? {}, priority: body.priority ?? 0 }); }
    catch (error) { if (driverError(error)?.code === '23505') fail('validation_failed', 422); throw error; }
    await tx.tasks.createStanding({ id: randomUUID(), projectId, createdBy: actor, revisionId: randomUUID() });
    return created(sendProject(row), `/projects/${projectId}`);
  }));
  register('GET', '/projects/{id}', async context => {
    const project = found(await repo.projects.get(id(context)));
    const policy = await repo.policies.effective(project.id);
    return json(200, { ...sendProject(project), policy: policy ? wire(executionPolicySchema, policy) : null });
  });
  register('PATCH', '/projects/{id}', mutation(repo, async (context, tx) => {
    const version = ifMatch(context);
    const project = found(await tx.projects.get(id(context), { lock: true }));
    if (version !== project.rowVersion) return conflict(project.rowVersion);
    const body = projectPatchSchema.parse(context.body);
    try {
      const updated = found(await tx.projects.update(project.id, version, { name: body.name, description: body.description,
        repositoryUrl: body.repository_url, defaultBranch: body.default_branch, workspacePolicy: body.workspace_policy,
        settings: body.settings, priority: body.priority }));
      return json(200, sendProject(updated));
    } catch (error) { if (driverError(error)?.code === '23505') fail('validation_failed', 422); throw error; }
  }));
  register('POST', '/projects/{id}/archive', mutation(repo, async (context, tx) => {
    const project = found(await tx.projects.get(id(context), { lock: true }));
    const version = ifMatch(context, project.rowVersion);
    if (version !== project.rowVersion) return conflict(project.rowVersion);
    if ((await tx.tasks.list({ projectId: project.id })).some(task => task.originType !== 'standing' && !finalStates.has(task.status ?? ''))) {
      return conflict(project.rowVersion, 'project_active');
    }
    if (project.archivedAt) return json(200, sendProject(project));
    return json(200, sendProject(found(await tx.projects.archive(project.id, version))));
  }));
  register('GET', '/projects/{id}/routing-rules', async context => {
    const query = listQuery(context, {});
    const project = found(await repo.projects.get(id(context)));
    return page(repo, context, query, await repo.routingRules.list(project.id, { includeDeleted: query.include_deleted }),
      row => row.position ?? 0, 'number', row => wire(routingRuleSchema, row));
  });
  register('POST', '/projects/{id}/routing-rules', mutation(repo, async (context, tx) => {
    const project = found(await tx.projects.get(id(context), { lock: true }));
    const body = routingRuleCreateSchema.parse(context.body);
    const row = await tx.routingRules.create({ id: randomUUID(), projectId: project.id, position: body.position,
      match: body.match, preferredAgentIds: body.preferred_agent_ids });
    return created(wire(routingRuleSchema, row), `/projects/${project.id}/routing-rules/${row.id}`);
  }));
  register('DELETE', '/projects/{id}/routing-rules/{rule}', mutation(repo, async (context, tx) => {
    const project = found(await tx.projects.get(id(context), { lock: true }));
    return json(200, wire(routingRuleSchema, found(await tx.routingRules.delete(id(context, 'rule'), project.id))));
  }));

  register('GET', '/tasks', async context => {
    const query = listQuery(context, {
      project_id: uuid.optional(), status: z.array(taskStateSchema).optional(), priority_gte: int.optional(), agent_id: uuid.optional(),
      parent_id: uuid.optional(), created_after: date.optional(), created_before: date.optional(), updated_after: date.optional(),
      awaiting_approval: z.literal('true').transform(() => true).optional(), q: z.string().optional(), origin_type: origins.optional(),
      sort: z.enum(['created_at', 'updated_at', 'priority']).optional(), direction: z.enum(['asc', 'desc']).optional(),
    });
    const rows = await repo.tasks.list({ includeDeleted: query.include_deleted, projectId: query.project_id, status: query.status,
      priorityGte: query.priority_gte, agentId: query.agent_id, parentId: query.parent_id, createdAfter: query.created_after,
      createdBefore: query.created_before, updatedAfter: query.updated_after, awaitingApproval: query.awaiting_approval,
      q: query.q, originType: query.origin_type });
    const visible = new Set((await repo.projects.list({ includeDeleted: query.include_deleted })).map(project => project.id));
    const matching = rows.filter(row => row.projectId && visible.has(row.projectId) && (query.origin_type === 'standing' || row.originType !== 'standing'));
    return page(repo, context, query, matching, row => query.sort === 'priority' ? row.priority ?? 0 :
      (query.sort === 'updated_at' ? row.updatedAt : row.createdAt).getTime(), 'number', sendTask, query.direction ?? 'desc');
  });
  register('POST', '/tasks', mutation(repo, async (context, tx, actor) => {
    const body = createTaskRequestSchema.parse(context.body);
    const project = found(await tx.projects.get(body.project_id, { lock: true }));
    const row = await tx.tasks.create({ id: randomUUID(), projectId: project.id, createdBy: actor, title: body.title,
      description: body.description, priority: body.priority }, { id: randomUUID(), requirements: body.requirements,
      acceptanceCriteria: body.acceptance_criteria, constraints: body.constraints });
    for (const dependency of new Set(body.depends_on.map(value => value.toLowerCase()))) await addDependency(tx, row.id, dependency, 'requires_accepted');
    await tx.outbox.create({ id: randomUUID(), taskId: row.id, kind: 'start_workflow', state: 'pending', attempts: 0, payload: { task_id: row.id } });
    return created({ ...await taskDetail(tx, row), workflow_start: 'recorded' }, `/tasks/${row.id}`);
  }));
  register('GET', '/tasks/{id}', async context => json(200, await taskDetail(repo, await taskAt(repo, id(context)))));
  register('DELETE', '/tasks/{id}', mutation(repo, async (context, tx) => {
    const task = await taskAt(tx, id(context), false, true);
    const version = ifMatch(context, task.rowVersion);
    if (version !== task.rowVersion) return conflict(task.rowVersion);
    try { return json(200, sendTask(found(await tx.tasks.softDelete(task.id, version)))); }
    catch (error) {
      if (error instanceof TaskDeleteRefusedError) throw new DecisionProblem('task_active', 409, Number(task.rowVersion));
      throw error;
    }
  }));

  const ordinaryTask = async (tx: Transaction, context: HandlerContext, lock = false) => {
    const task = await taskAt(tx, id(context), false, lock);
    return task.originType === 'standing' ? fail('not_found', 404) : task;
  };
  register('GET', '/tasks/{id}/revisions', async context => {
    const task = await ordinaryTask(repo, context);
    const query = listQuery(context, {});
    return page(repo, context, query, await repo.tasks.revisions(task.id), row => row.revisionNumber ?? 0, 'number', row => wire(resource.TaskRevision, row));
  });
  register('GET', '/tasks/{id}/revisions/{n}', async context => {
    const task = await ordinaryTask(repo, context);
    const row = found(await repo.tasks.getRevision(task.id, validate(positive, context.params.n)));
    return json(200, wire(resource.TaskRevision, row));
  });
  register('POST', '/tasks/{id}/dependencies', mutation(repo, async (context, tx) => {
    const task = await ordinaryTask(tx, context, true);
    const body = DependencyCreate.parse(context.body);
    const dep = body.depends_on_task_id.toLowerCase();
    const type = validate(z.literal('requires_accepted'), body.dependency_type);
    const row = await addDependency(tx, task.id, dep, type);
    return created(wire(resource.TaskDependency, row), `/tasks/${task.id}/dependencies/${dep}`);
  }));
  register('DELETE', '/tasks/{id}/dependencies/{dep}', mutation(repo, async (context, tx, actor) => {
    const task = await ordinaryTask(tx, context, true);
    const dependsOn = id(context, 'dep');
    const existing = found((await tx.tasks.dependencies(task.id)).find(row => row.dependsOnTaskId === dependsOn));
    const row = found(await tx.tasks.removeDependency(task.id, dependsOn, existing.rowVersion, actor));
    return json(200, wire(resource.TaskDependency, row));
  }));

  register('GET', '/tasks/{id}/runs', async context => {
    const task = await taskAt(repo, id(context));
    const query = listQuery(context, { role: z.string().optional(), status: z.string().optional() });
    return page(repo, context, query, await repo.taskReads.runs(task.id, query), row => row.attemptNumber ?? 0, 'number',
      row => wire(resource.TaskRun, row, { agent_version_id: null }));
  });
  register('GET', '/tasks/{id}/artifacts', async context => {
    const task = await taskAt(repo, id(context));
    const query = listQuery(context, { run_id: uuid.optional(), type: z.string().optional() });
    const workerId = context.identity?.role === 'worker' ? context.identity.workerId! : undefined;
    if (workerId) checkContract(context, contractVersion);
    const rows = await repo.taskReads.artifacts({ taskId: task.id, runId: query.run_id, type: query.type, workerId, includeDeleted: query.include_deleted ?? false });
    return page(repo, context, query, rows, row => row.createdAt.getTime(), 'number', row => wire(resource.TaskArtifact, row));
  }, async ({ scope }) => scope === 'own_runs'); // The repository restricts the read to runs belonging to this worker.
  register('GET', '/tasks/{id}/reviews', async context => {
    const task = await ordinaryTask(repo, context);
    const query = listQuery(context, {});
    return page(repo, context, query, await repo.taskReads.reviews(task.id), row => row.createdAt.getTime(), 'number',
      row => wire(resource.TaskReview, row, { outcomes: row.outcomes.map(outcome => wire(resource.ReviewFindingOutcome, outcome)) }));
  });
  register('GET', '/tasks/{id}/decisions', async context => {
    const task = await ordinaryTask(repo, context);
    const query = listQuery(context, {});
    return page(repo, context, query, await repo.decisions.listForTask(task.id), row => row.recordedAt.getTime(), 'number', sendDecision);
  });
  register('GET', '/decisions/{id}', async context => {
    const row = found(await repo.decisions.get(id(context)));
    await taskAt(repo, found(row.taskId));
    return json(200, sendDecision(row));
  });

  for (const route of routes.filter(route => route.operationId.startsWith('task_') && Object.hasOwn(decisionRequestSchemas, route.operationId.slice(5)))) {
    const kind = route.operationId.slice(5) as DecisionKind;
    register('POST', route.path, async context => {
      const taskId = id(context);
      const identity = context.identity!;
      const { press_id: press, telegram_user_id: telegramUser, ...body } = context.body as Record<string, unknown>;
      const telegram = identity.role === 'relay';
      const worker = identity.role === 'worker';
      if (!telegram && (press !== undefined || telegramUser !== undefined)) fail('validation_failed', 422);
      await taskAt(repo, taskId);
      if (kind === 'resolve_block') validate(z.enum(phaseTwoBlockKinds), body.block_kind);
      if (worker) checkContract(context, contractVersion);
      const engineer = worker ? await repo.taskReads.engineerRun(taskId, identity.workerId!, identity.runId, true) : undefined;
      if (worker && !engineer) fail('forbidden', 403);
      if (engineer && engineerNeedsOwner(body.answer, body.block_kind)) fail('owner_only', 422);
      const owner = worker ? undefined : telegram ? (await mappedOwner(repo, press, telegramUser))?.id : actorId(context);
      if (!worker && !owner) fail('forbidden', 403);
      const result = await recordDecision(repo, { taskId, kind, body, wireBody: telegram ? context.body : undefined, actorId: owner, engineerRunId: engineer?.id,
        channel: telegram ? 'telegram' : identity.role === 'device' ? 'client' : 'api',
        deviceSessionId: sessionId(context), pressId: telegram ? press as string : null, idempotencyKey: header(context, 'idempotency-key') ?? '',
        confirm: header(context, 'x-confirm'), windowSeconds: await setting(repo, 'confirm.windowSeconds'), now: clock(),
        http: { requestId: context.requestId, tokenId: identity.id, workerId: worker ? identity.workerId! : undefined },
      });
      const headers: Record<string, string> = {};
      if (result.replayed) headers['Idempotent-Replay'] = 'true';
      if (result.status === 202) headers.Location = result.location;
      return json(result.status, result.body, headers);
    }, async ({ scope, body, params, identity }) => {
      if (scope === 'owner_press') {
        const data = body as Record<string, unknown>;
        return Boolean(await mappedOwner(repo, data.press_id, data.telegram_user_id));
      }
      return scope === 'chief_engineer_run' && uuid.safeParse(params.id).success &&
        Boolean(await repo.taskReads.engineerRun(params.id!, identity.workerId!, identity.runId, true));
    });
  }
}

function checkContract(context: HandlerContext, current: number) {
  const version = header(context, 'x-factory-contract');
  if (version !== String(current) && (current === 1 || version !== String(current - 1))) fail('contract_unsupported', 426);
}

function mappedOwner(repo: Repo, press: unknown, telegramId: unknown) {
  return typeof press === 'string' && press.length > 0 && typeof telegramId === 'number' && Number.isSafeInteger(telegramId) && telegramId > 0
    ? repo.owners.byTelegramUserId(BigInt(telegramId)) : undefined;
}

function engineerNeedsOwner(answer: unknown, blockKind: unknown) {
  // Resolve-block accepts JSON. Disallow limit increases and dangerous choices inside that answer as well as bare choices.
  const reserved = /^(?:raise_(?:cost|budget|tokens|time)|(?:max_)?(?:cost|budget|tokens|time|run_seconds)|dangerous(?:_operation)?|publish|merge|release|rewrite_history|delete)$/;
  const ownerChoice = (choice: string) => {
    const name = choice.trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[. -]+/g, '_');
    return reserved.test(name) || (name === 'raise_limit' && blockKind !== 'rework_limit');
  };
  const values = [answer];
  while (values.length) {
    const value = values.pop();
    if (typeof value === 'string' && ownerChoice(value)) return true;
    if (Array.isArray(value)) values.push(...value);
    else if (value && typeof value === 'object') {
      for (const [key, field] of Object.entries(value)) {
        if (ownerChoice(key)) return true;
        values.push(field);
      }
    }
  }
  return false;
}
