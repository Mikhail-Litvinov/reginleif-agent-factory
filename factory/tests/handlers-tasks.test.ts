import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { DecisionKind } from '../api/decisions.ts';
import { registerTasks } from '../api/handlers/tasks.ts';
import { createApiServer } from '../api/server.ts';
import { routes } from '../contracts/routes.ts';
import { blockedKindTargets, canTransition, phaseTwoBlockKinds, taskStates, type BlockKind, type TaskState } from '../contracts/states.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo, type Repo } from '../db/repo/index.ts';
import { TransitionRefusedError } from '../db/repo/tasks.ts';
import { connectBench, databaseBench } from './database-bench.ts';

type Role = 'owner' | 'reader' | 'relay' | 'worker' | 'otherWorker' | 'registry' | 'hub' | 'device' | 'none';
const owner = randomUUID(), worker = randomUUID(), otherWorker = randomUUID(), agent = randomUUID(), reviewer = randomUUID();
const policy = randomUUID(), device = randomUUID(), session = randomUUID();
const telegramUser = 17; // A fixture principal distinct from an unmapped Telegram user.
const tokens = new Map<Role, string>();
const settings = { 'confirm.windowSeconds': 60, 'page.default': 5, 'page.max': 25 }; // Bench settings exercise both configured page bounds and the confirmation window.
const now = new Date('2030-01-01T00:00:00.000Z');
let sql: ReturnType<typeof connectBench>, apiSql: typeof sql, controlSql: typeof sql;
let api: ReturnType<typeof createApiServer>, repo: Repo, control: Repo, base: string;

// Registered at module level: node:test attaches the teardown to the running hook when it is called inside one, which would drop the database right after setup.
const benchPromise = databaseBench(import.meta.url);

before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  sql = connectBench(bench.migratorUrl);
  apiSql = connectBench(bench.apiUrl);
  controlSql = connectBench(bench.controlUrl);
  repo = createRepo(drizzle(apiSql));
  control = createRepo(drizzle(controlSql));
  await sql`INSERT INTO owners (id, name, telegram_user_id) VALUES (${owner}, 'Owner', ${telegramUser})`;
  await sql`INSERT INTO workers (id, machine_id) VALUES (${worker}, 'mine'), (${otherWorker}, 'other')`;
  await sql`INSERT INTO agents (id, name, provider) VALUES (${agent}, 'agent', 'claude'), (${reviewer}, 'reviewer', 'codex')`;
  await sql`INSERT INTO execution_policies (id, version, allowed_commands, allowed_directories, allowed_repositories, network,
    git_operations, confirmation_required, allowed_tools, created_by) VALUES (${policy}, 1, '{}', '{}', '{}', '{}', '{}', '{}', '{}', ${owner})`;
  await sql`INSERT INTO settings ${sql(Object.entries(settings).map(([key, value]) => ({ key, value })), 'key', 'value')}`;
  await sql`INSERT INTO devices (id, owner_id) VALUES (${device}, ${owner})`;
  for (const role of ['owner', 'reader', 'relay', 'worker', 'otherWorker', 'registry', 'hub', 'device'] as const) {
    const prefix = `test-${role}`, secret = randomUUID();
    const hash = createHash('sha256').update(secret).digest('hex');
    tokens.set(role, `Bearer afk_${prefix}_${secret}`);
    if (role === 'device') {
      await sql`INSERT INTO device_sessions (id, device_id, prefix, token_hash) VALUES (${session}, ${device}, ${prefix}, ${hash})`;
    } else {
      await sql`INSERT INTO api_tokens (id, role, owner_id, worker_id, session_ref, prefix, token_hash)
        VALUES (${randomUUID()}, ${role === 'otherWorker' ? 'worker' : role}, ${role === 'owner' ? owner : null},
        ${role === 'worker' ? worker : role === 'otherWorker' ? otherWorker : null}, ${role === 'registry' ? 'own-session' : null}, ${prefix}, ${hash})`;
    }
  }
  api = createApiServer({ tokens: { byHash: async hash => {
    const token = await repo.tokens.byHash(hash);
    if (token) return token;
    const row = await repo.deviceSessions.byTokenHash(hash);
    if (!row) return undefined;
    const parent = row.deviceId && await repo.devices.get(row.deviceId);
    return parent && !parent.revokedAt ? { ...row, role: 'device', workerId: null, validUntil: null, ownerId: parent.ownerId } : undefined;
  } } });
  registerTasks(api, repo, { clock: () => now });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

after(async () => {
  await api?.close();
  await Promise.all([sql?.end(), apiSql?.end(), controlSql?.end()]);
});

const seen = new Set<string>();
async function call(method: string, path: string, { role = 'owner', body, headers = {} }: {
  role?: Role; body?: unknown; headers?: Record<string, string>;
} = {}) {
  const requestHeaders = new Headers(headers);
  if (!['GET', 'HEAD'].includes(method) && !requestHeaders.has('Idempotency-Key')) requestHeaders.set('Idempotency-Key', randomUUID());
  if (role !== 'none') requestHeaders.set('Authorization', tokens.get(role)!);
  if (role === 'worker' || role === 'otherWorker') requestHeaders.set('X-Factory-Contract', '1');
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
}

type Answer = Awaited<ReturnType<typeof call>>;
function success(method: string, template: string, answer: Answer, status: number) {
  assert.equal(answer.status, status, `${method} ${template}: ${JSON.stringify(answer.body)}`);
  const schema = routes.find(route => route.method === method && route.path === template)?.responses[status];
  assert.ok(schema instanceof z.ZodType);
  schema.parse(answer.body);
  if (status === 201 || status === 202) assert.ok(answer.headers.get('location'));
  seen.add(`${method} ${template}`);
  return answer.body;
}

function refused(answer: Answer, status: number, code: string) {
  assert.equal(answer.status, status, JSON.stringify(answer.body));
  assert.equal(answer.body.code, code);
  assert.equal(answer.headers.get('content-type'), 'application/problem+json');
  assert.equal(answer.body.request_id, answer.headers.get('x-request-id'));
}

async function makeProject() {
  const name = `project-${randomUUID()}`;
  return success('POST', '/projects', await call('POST', '/projects', { body: { name, repository_url: 'https://example.invalid/repo' } }), 201);
}

const taskInput = (projectId: string, dependsOn: string[] = []) => ({ project_id: projectId, title: 'Task', description: '', priority: 1,
  requirements: 'Do the work', acceptance_criteria: [{ id: 'check' }], constraints: {}, depends_on: dependsOn });

async function makeTask(projectId: string, dependsOn?: string[]) {
  const response = await call('POST', '/tasks', { body: taskInput(projectId, dependsOn) });
  const row = success('POST', '/tasks', response, 201);
  assert.equal(response.headers.get('location'), `/tasks/${row.id}`);
  assert.equal(row.created_by, owner);
  assert.equal(row.workflow_start, 'recorded');
  return row;
}

const toState: Record<TaskState, readonly TaskState[]> = {
  CREATED: [], PLANNING: ['PLANNING'], READY: ['PLANNING', 'READY'], WAITING_DEPENDENCIES: ['PLANNING', 'READY', 'WAITING_DEPENDENCIES'],
  ASSIGNED: ['PLANNING', 'READY', 'ASSIGNED'], RUNNING: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING'],
  VERIFYING: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING', 'VERIFYING'],
  AWAITING_APPROVAL: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL'],
  REWORK_REQUIRED: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING', 'VERIFYING', 'REWORK_REQUIRED'], BLOCKED: ['PLANNING', 'BLOCKED'],
  ACCEPTED: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL', 'ACCEPTED'],
  REJECTED: ['PLANNING', 'READY', 'ASSIGNED', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL', 'REJECTED'],
  CANCELLED: ['CANCELLED'], FAILED: ['PLANNING', 'FAILED'], PAUSED: ['PAUSED'], CANCELLING: ['CANCELLING'],
};

async function transition(task: string, to: TaskState, patch: Parameters<Repo['tasks']['transition']>[3] = {}) {
  const current = (await control.tasks.get(task))!;
  const row = await control.tasks.transition(task, current.rowVersion, to, patch);
  assert.equal(row?.status, to);
  return row!;
}

async function drive(task: string, state: TaskState, blockKind: BlockKind = 'execution', blockHandler: 'owner' | 'chief_engineer' = 'chief_engineer') {
  const route = state !== 'BLOCKED' || blockKind === 'scope' ? toState[state] : [
    ...toState[blockKind === 'dependency' ? 'WAITING_DEPENDENCIES' : blockKind === 'check_environment' || blockKind === 'rework_limit' ? 'VERIFYING' : 'RUNNING'],
    'BLOCKED' as const,
  ];
  for (const step of route) {
    await transition(task, step, step === 'BLOCKED' ? { blockKind, blockHandler } : step === 'PAUSED' ? { resumeTo: 'CREATED' } : {});
  }
}

const decisionPaths = { approve: 'approve', reject: 'reject', request_changes: 'request-changes', cancel: 'cancel', pause: 'pause', resume: 'resume',
  revise_requirements: 'revisions', add_feedback: 'feedback', change_priority: 'priority', resolve_block: 'resolve-block',
  force_close: 'force-close', allow_agent: 'allow-agent' } satisfies Record<DecisionKind, string>;
const kinds = Object.keys(decisionPaths) as DecisionKind[];
const defaultBodies: Record<DecisionKind, object> = {
  approve: { revision_number: 1, comment: '' }, reject: { revision_number: 1, reason: 'Fixture' },
  request_changes: { revision_number: 1, findings: [], comment: '' }, cancel: { reason: 'Fixture' }, pause: { reason: 'Fixture' },
  resume: { reason: 'Fixture' }, revise_requirements: { revision_number: 1, requirements: 'Revised', acceptance_criteria: [], constraints: {}, change_reason: 'Fixture' },
  add_feedback: { text: 'Fixture' }, change_priority: { priority: 2 }, resolve_block: { block_kind: 'execution', revision_number: 1, answer: 'retry' },
  force_close: { reason: 'Fixture' }, allow_agent: { agent_id: agent },
};
const danger = new Set<DecisionKind>(['reject', 'cancel', 'force_close']);

async function decide(task: string, kind: DecisionKind, body: object = defaultBodies[kind], role?: Role) {
  const path = `/tasks/${task}/${decisionPaths[kind]}`;
  let headers: Record<string, string> | undefined;
  if (danger.has(kind)) {
    const first = await call('POST', path, { role, body });
    refused(first, 409, 'confirmation_required');
    assert.equal(Date.parse(first.body.expires_at) - now.getTime(), settings['confirm.windowSeconds'] * 1000);
    headers = { 'X-Confirm': `${first.body.confirmation_id}.${first.body.nonce}` };
  }
  return call('POST', path, { role, body, headers });
}

async function recorded(task: string, kind: DecisionKind, response: Answer) {
  const decision = success('POST', `/tasks/{id}/${decisionPaths[kind]}`, response, 202);
  assert.equal(decision.kind, kind);
  assert.equal(decision.delivery_state, 'recorded');
  assert.equal(decision.refusal_reason, null);
  assert.equal(response.headers.get('location'), `/decisions/${decision.id}`);
  const row = (await repo.decisions.get(decision.id))!;
  assert.equal(row.taskId, task);
  assert.equal(row.deliveryState, 'recorded');
  assert.equal((await repo.outbox.get(row.outboxId!))?.decisionId, row.id);
  return row;
}

async function newRun(task: string, workerId: string, role: 'implementer' | 'chief_engineer' | 'reviewer', attempt = 1) {
  const run = randomUUID();
  await sql`INSERT INTO task_runs (id, task_id, worker_id, role, status, attempt_number, agent_id, policy_id, task_revision, contract_version)
    VALUES (${run}, ${task}, ${workerId}, ${role}, 'running', ${attempt}, ${role === 'reviewer' ? reviewer : agent}, ${policy}, 1, 1)`;
  return run;
}

test('project, routing, task, revision, and dependency routes preserve wire shapes, versions and visibility', async () => {
  const project = await makeProject();
  const path = `/projects/${project.id}`;
  const listed = success('GET', '/projects', await call('GET', `/projects?q=${project.name}`, { role: 'relay' }), 200);
  assert.deepEqual(listed.items.map((item: { id: string }) => item.id), [project.id]);
  const detail = success('GET', '/projects/{id}', await call('GET', path, { role: 'reader' }), 200);
  assert.equal(detail.policy.id, policy);
  const patch = { body: { name: project.name, description: 'Updated' }, headers: { 'If-Match': `"${project.row_version}"`, 'Idempotency-Key': randomUUID() } };
  const patched = success('PATCH', '/projects/{id}', await call('PATCH', path, patch), 200);
  assert.equal(patched.row_version, project.row_version + 1);
  const retry = await call('PATCH', path, patch);
  assert.equal(retry.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(retry.body, patched);
  const stale = await call('PATCH', path, { ...patch, headers: { 'If-Match': String(project.row_version) } });
  refused(stale, 409, 'version_conflict');
  assert.equal(stale.body.current_row_version, patched.row_version);
  const inflightKey = randomUUID();
  await control.transaction(async tx => {
    await tx.decisions.lockKey(owner, inflightKey);
    const inFlight = await call('PATCH', path, { ...patch, headers: { 'If-Match': String(patched.row_version), 'Idempotency-Key': inflightKey } });
    refused(inFlight, 409, 'idempotency_in_progress');
    assert.equal(inFlight.headers.get('retry-after'), '1');
  });

  const rulePath = `${path}/routing-rules`;
  const rule = success('POST', '/projects/{id}/routing-rules', await call('POST', rulePath, { body: { match: {}, preferred_agent_ids: [agent], position: 1 } }), 201);
  const foreign = await makeProject();
  refused(await call('DELETE', `/projects/${foreign.id}/routing-rules/${rule.id}`), 404, 'not_found');
  assert.equal(success('GET', '/projects/{id}/routing-rules', await call('GET', rulePath), 200).items[0].id, rule.id);
  assert.ok(success('DELETE', '/projects/{id}/routing-rules/{rule}', await call('DELETE', `${rulePath}/${rule.id}`), 200).deleted_at);
  assert.deepEqual((await call('GET', rulePath)).body.items, []);
  assert.equal((await call('GET', `${rulePath}?include_deleted=true`)).body.items[0].id, rule.id);
  refused(await call('GET', `${rulePath}?include_deleted=true`, { role: 'reader' }), 403, 'forbidden');

  const dep = await makeTask(project.id);
  const task = await makeTask(project.id, [dep.id]);
  const crossProject = `cross-project-${randomUUID()}`;
  refused(await call('POST', '/tasks', { body: { ...taskInput(foreign.id, [dep.id]), title: crossProject } }), 422, 'validation_failed');
  assert.deepEqual([...await sql`SELECT id FROM tasks WHERE title = ${crossProject}`], []);
  const start = await sql`SELECT payload FROM outbox_events WHERE task_id = ${task.id} AND kind = 'start_workflow'`;
  assert.deepEqual(start.map(row => row.payload), [{ task_id: task.id }]);
  assert.equal(task.revision.revision_number, 1);
  assert.equal(task.dependencies[0].depends_on_task_id, dep.id);
  refused(await call('POST', `${path}/archive`), 409, 'project_active');
  refused(await call('DELETE', `/tasks/${task.id}`), 409, 'task_active');
  const query = `/tasks?project_id=${project.id}&status=CREATED&status=READY&sort=priority&direction=asc&limit=1`;
  const page = success('GET', '/tasks', await call('GET', query, { role: 'device' }), 200);
  const next = await call('GET', `${query}&cursor=${page.next_cursor}`, { role: 'device' });
  assert.equal(next.status, 200);
  assert.equal(next.body.next_cursor, null);
  assert.deepEqual(new Set([page.items[0].id, next.body.items[0].id]), new Set([task.id, dep.id]));
  refused(await call('GET', `${query}&cursor=${page.next_cursor}`, { role: 'reader' }), 400, 'bad_cursor');
  refused(await call('GET', `${query}&unknown=x`), 422, 'validation_failed');
  const standing = (await call('GET', `/tasks?project_id=${project.id}&origin_type=standing`)).body.items[0];
  assert.equal(standing.status, 'RUNNING');
  assert.equal((await call('GET', `/tasks/${standing.id}`)).status, 200);
  refused(await call('GET', `/tasks/${standing.id}/revisions`), 404, 'not_found');
  refused(await decide(standing.id, 'pause'), 409, 'not_allowed_in_state');
  refused(await call('DELETE', `/tasks/${standing.id}`), 409, 'task_active');

  const taskPath = `/tasks/${task.id}`;
  assert.equal(success('GET', '/tasks/{id}', await call('GET', taskPath, { role: 'reader' }), 200).revision.id, task.revision.id);
  const revision = await recorded(task.id, 'revise_requirements', await decide(task.id, 'revise_requirements'));
  const revPage = success('GET', '/tasks/{id}/revisions', await call('GET', `${taskPath}/revisions`), 200);
  assert.deepEqual(revPage.items.map((row: { revision_number: number }) => row.revision_number), [1, 2]);
  const rev = success('GET', '/tasks/{id}/revisions/{n}', await call('GET', `${taskPath}/revisions/2`), 200);
  assert.equal(rev.decision_id, revision.id);
  assert.equal((await call('GET', taskPath)).body.revision.revision_number, 1);
  refused(await call('POST', `/tasks/${dep.id}/dependencies`, { body: { depends_on_task_id: task.id, dependency_type: 'requires_accepted' } }), 409, 'dependency_cycle');
  refused(await call('POST', `${taskPath}/dependencies`, { body: { depends_on_task_id: task.id, dependency_type: 'requires_accepted' } }), 409, 'dependency_cycle');
  const dep2 = await makeTask(project.id);
  const edge = success('POST', '/tasks/{id}/dependencies', await call('POST', `${taskPath}/dependencies`, { body: { depends_on_task_id: dep2.id, dependency_type: 'requires_accepted' } }), 201);
  assert.equal(edge.depends_on_task_id, dep2.id);
  const removed = success('DELETE', '/tasks/{id}/dependencies/{dep}', await call('DELETE', `${taskPath}/dependencies/${dep2.id}`), 200);
  assert.ok(removed.removed_at);
  assert.equal(removed.removed_by, owner);
  assert.deepEqual((await call('GET', taskPath)).body.dependencies.map((row: { depends_on_task_id: string }) => row.depends_on_task_id), [dep.id]);

  const ownRun = await newRun(task.id, worker, 'implementer');
  const foreignRun = await newRun(task.id, otherWorker, 'implementer', 2);
  const ownArtifact = randomUUID();
  await sql`INSERT INTO task_artifacts (id, task_id, run_id, artifact_type, storage_backend, storage_key, checksum, size, upload_state)
    VALUES (${ownArtifact}, ${task.id}, ${ownRun}, 'log', 'fs', ${ownArtifact}, 'checksum', 0, 'confirmed'),
    (${randomUUID()}, ${task.id}, ${foreignRun}, 'log', 'fs', ${foreignRun}, 'checksum', 0, 'confirmed')`;
  assert.equal(success('GET', '/tasks/{id}/runs', await call('GET', `${taskPath}/runs?status=running&role=implementer`), 200).items.length, 2);
  const own = success('GET', '/tasks/{id}/artifacts', await call('GET', `${taskPath}/artifacts?type=log`, { role: 'worker' }), 200);
  assert.deepEqual(own.items.map((row: { id: string }) => row.id), [ownArtifact]);
  assert.deepEqual((await call('GET', `${taskPath}/artifacts?run_id=${foreignRun}`, { role: 'worker' })).body.items, []);
  const reviewRun = await newRun(task.id, worker, 'reviewer', 3);
  const review = randomUUID(), outcome = randomUUID();
  await sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id, round, verdict, findings)
    VALUES (${review}, ${task.id}, ${reviewRun}, ${reviewer}, 1, 'pass', '[]')`;
  await sql`INSERT INTO review_finding_outcomes (id, review_id, finding_key, outcome, run_id)
    VALUES (${outcome}, ${review}, 'fixture', 'confirmed', ${reviewRun})`;
  assert.equal(success('GET', '/tasks/{id}/reviews', await call('GET', `${taskPath}/reviews`), 200).items[0].outcomes[0].id, outcome);
  assert.equal(success('GET', '/tasks/{id}/decisions', await call('GET', `${taskPath}/decisions`), 200).items[0].id, revision.id);
  const decision = success('GET', '/decisions/{id}', await call('GET', `/decisions/${revision.id}`), 200);
  assert.equal(Object.hasOwn(decision, 'request_hash'), false);
  assert.equal(Object.hasOwn(decision, 'idempotency_key'), false);

  for (const role of ['reader', 'registry', 'hub', 'worker', 'relay', 'none'] as const) {
    refused(await call('POST', '/tasks', { role, body: taskInput(project.id) }), role === 'none' ? 401 : 403, role === 'none' ? 'unauthenticated' : 'forbidden');
  }
  const relayBody = { text: 'Telegram', telegram_user_id: telegramUser, press_id: randomUUID() };
  const relay = await recorded(task.id, 'add_feedback', await decide(task.id, 'add_feedback', relayBody, 'relay'));
  assert.equal(relay.actorId, owner);
  assert.equal(relay.channel, 'telegram');
  refused(await decide(task.id, 'add_feedback', relayBody, 'relay'), 409, 'press_replayed');
  refused(await decide(task.id, 'add_feedback', { ...relayBody, telegram_user_id: telegramUser + 1 }, 'relay'), 403, 'forbidden');
  const client = await recorded(task.id, 'add_feedback', await decide(task.id, 'add_feedback', defaultBodies.add_feedback, 'device'));
  assert.equal(client.deviceSessionId, session);
  assert.equal(client.channel, 'client');

  await drive(task.id, 'CANCELLED');
  refused(await call('DELETE', taskPath, { headers: { 'If-Match': String(task.row_version) } }), 409, 'version_conflict');
  const deleted = success('DELETE', '/tasks/{id}', await call('DELETE', taskPath), 200);
  assert.ok(deleted.deleted_at);
  refused(await call('GET', taskPath), 404, 'not_found');
  await drive(dep.id, 'CANCELLED');
  await drive(dep2.id, 'FAILED');
  assert.ok(success('POST', '/projects/{id}/archive', await call('POST', `${path}/archive`), 200).archived_at);
  await sql`UPDATE projects SET deleted_at = now(), row_version = row_version + 1 WHERE id = ${project.id}`;
  refused(await call('GET', path), 404, 'not_found');
  assert.deepEqual((await call('GET', `/projects?q=${project.name}`)).body.items, []);
  assert.equal((await call('GET', `/projects?q=${project.name}&include_deleted=true`)).body.items[0].id, project.id);
});

// temporal.md Operations matrix, with no live run or held pause flag. Phase 2 records every owner decision.
const applies: Record<TaskState, readonly DecisionKind[]> = {
  CREATED: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  PLANNING: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  READY: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  WAITING_DEPENDENCIES: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  ASSIGNED: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority', 'allow_agent'],
  RUNNING: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  VERIFYING: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  AWAITING_APPROVAL: ['approve', 'reject', 'request_changes', 'cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  REWORK_REQUIRED: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority'],
  BLOCKED: ['cancel', 'pause', 'revise_requirements', 'add_feedback', 'change_priority', 'resolve_block'],
  PAUSED: ['resume', 'cancel', 'add_feedback', 'revise_requirements'], CANCELLING: ['cancel', 'force_close'],
  ACCEPTED: [], REJECTED: [], CANCELLED: [], FAILED: [],
};
const final = new Set<TaskState>(['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED']);

async function exposeOutcome(task: string, decisionId: string, reason: string | null) {
  const delivery = reason ? 'refused' : 'applied';
  // Write the phase-3 outcome fixture through the control repository. The HTTP routes only record and read it.
  const notice = await control.transaction(async tx => {
    await tx.decisions.updateDelivery(decisionId, { deliveryState: delivery, refusalReason: reason, deliveredAt: now, resolvedAt: now });
    return reason ? tx.notifications.create({ id: randomUUID(), taskId: task, eventType: 'decision_refused', state: 'open',
      dedupKey: `decision-refused:${decisionId}`, occurrences: 1 }) : null;
  });
  const response = await call('GET', `/decisions/${decisionId}`, { role: 'reader' });
  assert.equal(response.status, 200);
  assert.equal(response.body.delivery_state, delivery);
  assert.equal(response.body.refusal_reason, reason);
  assert.equal(response.body.task_id, task);
  if (notice) assert.equal((await repo.notifications.list({ eventType: 'decision_refused', limit: 1 }))[0]?.id, notice.id);
}

test('ops-matrix API and database side: every state and decision plus the chief-engineer actor', async () => {
  const project = await makeProject();
  for (const state of taskStates) {
    const task = await makeTask(project.id);
    await drive(task.id, state);
    for (const kind of kinds) {
      const row = await recorded(task.id, kind, await decide(task.id, kind));
      assert.equal((await repo.tasks.get(task.id))?.status, state, `${state}/${kind}`);
      const reason = final.has(state) ? 'task_closed' : applies[state].includes(kind) ? null : 'not_allowed_in_state';
      await exposeOutcome(task.id, row.id, reason);
    }
    if (state === 'BLOCKED') {
      const run = await newRun(task.id, worker, 'chief_engineer');
      const solved = await recorded(task.id, 'resolve_block', await decide(task.id, 'resolve_block', defaultBodies.resolve_block, 'worker'));
      assert.equal(solved.engineerRunId, run);
      assert.equal(solved.actorId, null);
      for (const answer of ['raise_cost', { choice: { raise_limit: { max_cost: 5 } } }, ['publish']]) {
        refused(await decide(task.id, 'resolve_block', { ...defaultBodies.resolve_block, answer }, 'worker'), 422, 'owner_only');
      }
      refused(await decide(task.id, 'resolve_block', defaultBodies.resolve_block, 'otherWorker'), 403, 'forbidden');
      for (const [body, reason] of [
        [{ ...defaultBodies.resolve_block, block_kind: 'dependency' }, 'block_kind_mismatch'],
        [{ ...defaultBodies.resolve_block, revision_number: 2 }, 'revision_stale'],
        [defaultBodies.resolve_block, 'already_resolved'], [defaultBodies.resolve_block, 'actor_not_allowed'],
        [defaultBodies.resolve_block, 'block_handled'],
      ] as const) {
        const decision = await recorded(task.id, 'resolve_block', await decide(task.id, 'resolve_block', body));
        await exposeOutcome(task.id, decision.id, reason);
      }
    } else {
      refused(await decide(task.id, 'resolve_block', defaultBodies.resolve_block, 'worker'), 403, 'forbidden');
    }
  }
  const expected = [...routes.filter(route => /^\/(projects|tasks|decisions)(\/|$)/.test(route.path) &&
    !/(\/policy|\/events|\/publish|\/cleanup|\/participants|\/proposals)$/.test(route.path)).map(route => `${route.method} ${route.path}`)];
  assert.deepEqual([...seen].sort(), expected.sort());
});

const exitByState: Partial<Record<TaskState, { kind: DecisionKind; next: TaskState }>> = {
  CREATED: { kind: 'pause', next: 'PAUSED' }, PLANNING: { kind: 'cancel', next: 'CANCELLED' },
  READY: { kind: 'pause', next: 'PAUSED' }, WAITING_DEPENDENCIES: { kind: 'pause', next: 'PAUSED' },
  ASSIGNED: { kind: 'cancel', next: 'CANCELLED' }, RUNNING: { kind: 'cancel', next: 'CANCELLING' },
  VERIFYING: { kind: 'cancel', next: 'CANCELLED' }, AWAITING_APPROVAL: { kind: 'approve', next: 'ACCEPTED' },
  REWORK_REQUIRED: { kind: 'cancel', next: 'CANCELLED' }, PAUSED: { kind: 'resume', next: 'CREATED' },
  CANCELLING: { kind: 'force_close', next: 'CANCELLED' },
};

test('state-exit API and database side: recorded exits, guarded successors, and all seven block kinds', async () => {
  const project = await makeProject();
  const databaseRows = await sql<{ from_status: TaskState; to_status: TaskState }[]>`SELECT from_status,to_status FROM task_transitions`;
  for (const state of taskStates) {
    if (state === 'BLOCKED') continue;
    const task = await makeTask(project.id);
    await drive(task.id, state);
    for (const next of taskStates) {
      assert.equal(databaseRows.some(row => row.from_status === state && row.to_status === next), canTransition(state, next), `${state} -> ${next}`);
    }
    if (final.has(state)) {
      await assert.rejects(transition(task.id, 'CREATED'), TransitionRefusedError);
      continue;
    }
    const { kind, next } = exitByState[state]!;
    await recorded(task.id, kind, await decide(task.id, kind));
    assert.equal((await repo.tasks.get(task.id))?.status, state);
    const updated = await transition(task.id, next, next === 'PAUSED' ? { resumeTo: state } : state === 'CANCELLING' ? { endUnconfirmed: true } : {});
    if (state === 'CANCELLING') assert.equal(updated.endUnconfirmed, true);
  }
  for (const blockKind of phaseTwoBlockKinds) {
    const next = blockedKindTargets.find(rule => rule.kind === blockKind)!.to_status;
    const body = { block_kind: blockKind, resume_to: next, revision_number: 1 };
    const task = await makeTask(project.id);
    await drive(task.id, 'BLOCKED', blockKind, 'owner');
    await recorded(task.id, 'resolve_block', await decide(task.id, 'resolve_block', body));
    assert.equal((await transition(task.id, next)).blockHandler, null);
    const chief = await makeTask(project.id);
    if (blockKind === 'scope' || blockKind === 'agent_question') {
      await assert.rejects(drive(chief.id, 'BLOCKED', blockKind), TransitionRefusedError);
      refused(await decide(chief.id, 'resolve_block', body, 'worker'), 403, 'forbidden');
      continue;
    }
    await drive(chief.id, 'BLOCKED', blockKind);
    const run = await newRun(chief.id, worker, 'chief_engineer');
    assert.equal((await recorded(chief.id, 'resolve_block', await decide(chief.id, 'resolve_block', body, 'worker'))).engineerRunId, run);
    const handoff = { block_kind: blockKind, choice: 'call_owner', reason: 'Needs owner input' };
    refused(await decide(chief.id, 'resolve_block', handoff), 403, 'forbidden');
    assert.equal((await recorded(chief.id, 'resolve_block', await decide(chief.id, 'resolve_block', handoff, 'worker'))).engineerRunId, run);
    assert.equal((await repo.tasks.get(chief.id))?.blockHandler, 'chief_engineer');
    await transition(chief.id, 'BLOCKED', { blockHandler: 'owner' });
    refused(await decide(chief.id, 'resolve_block', body, 'worker'), 409, 'block_handled');
    await recorded(chief.id, 'resolve_block', await decide(chief.id, 'resolve_block', body));
    assert.equal((await transition(chief.id, next)).blockKind, null);
  }
});
