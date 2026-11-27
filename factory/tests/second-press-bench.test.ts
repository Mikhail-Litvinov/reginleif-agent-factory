import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { routes, type Route } from '../contracts/routes.ts';
import { createApiServer } from '../api/server.ts';
import { registerAllHandlers } from '../api/handlers/register-all.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo, type Repo } from '../db/repo/index.ts';
import { connectBench, databaseBench, jsonb } from './database-bench.ts';
import { issueConfirmation } from '../api/second-press.ts';

const benchPromise = databaseBench(import.meta.url);
const owner = randomUUID(), project = randomUUID(), secret = randomUUID(), relaySecret = randomUUID();
const clock = new Date();
let sql: ReturnType<typeof connectBench>, repo: Repo, api: ReturnType<typeof createApiServer>, base: string;

// Discover registrations from the same entry point used in production, so later packages enter this test automatically.
const probe = createApiServer({ tokens: { byHash: async () => undefined } });
const registered = new Set<string>();
const register = probe.register.bind(probe);
probe.register = (method, path, handler, options) => { registered.add(`${method} ${path}`); register(method, path, handler, options); };
registerAllHandlers(probe, {} as Repo);
const covered = routes.filter(route => route.secondPress && registered.has(`${route.method} ${route.path}`));

before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  sql = connectBench(bench.migratorUrl);
  repo = createRepo(drizzle(sql));
  await sql`INSERT INTO owners (id, name, telegram_user_id) VALUES (${owner}, 'Bench owner', 42)`;
  await sql`INSERT INTO projects (id, name, repository_url, default_branch, workspace_policy) VALUES (${project}, 'Press bench', 'https://example.test/press.git', 'main', 'worktree')`;
  await repo.tokens.create({ id: randomUUID(), ownerId: owner, role: 'owner', prefix: 'press', tokenHash: createHash('sha256').update(secret).digest('hex') });
  await repo.tokens.create({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash: createHash('sha256').update(relaySecret).digest('hex') });
  // Explicit bench settings; api.md specifies the confirmation window, but does not prescribe its value.
  await repo.settings.set('confirm.windowSeconds', 60, owner);
  await repo.settings.set('device.codeTtlSeconds', 300, owner);
  // The registry routes are refused while the feature is off; the clause limit is read when a regulation is activated.
  await repo.settings.set('registry.enabled', true, owner);
  await repo.settings.set('registry.clauseMaxBytes', 4096, owner);
  api = createApiServer({ tokens: repo.tokens, clock: () => clock });
  registerAllHandlers(api, repo, { now: () => clock });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
after(async () => { await api?.close(); await sql?.end(); });

type Fixture = { path: string; body?: unknown; secondBody?: unknown; headers?: Record<string, string> };
async function call(route: Pick<Route, 'method' | 'secondPress'>, fixture: Fixture, key: string, confirmation?: string, method: string = route.method) {
  const headers: Record<string, string> = { authorization: route.secondPress === 'sensitive-draft' ? `Bearer afk_relay_${relaySecret}` : `Bearer afk_press_${secret}`, 'idempotency-key': key, ...fixture.headers };
  if (fixture.body !== undefined) headers['content-type'] = 'application/json';
  if (confirmation) headers['X-Confirm'] = confirmation;
  const res = await fetch(base + fixture.path, { method, headers, body: fixture.body === undefined ? undefined : JSON.stringify(fixture.body) });
  // A 204 answer (stop-all) has no body.
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
async function task(status = 'CREATED') {
  const id = randomUUID();
  await sql`INSERT INTO tasks (id, project_id, status, depth, workflow_id, origin_type, current_revision) VALUES (${id}, ${project}, ${status}, 0, ${'task-' + id}, 'owner', 1)`;
  return id;
}
const policy = { allowed_commands: [], allowed_directories: [], allowed_repositories: [], git_operations: [], confirmation_required: [], allowed_tools: [], network: {}, max_concurrent_tasks: null, max_tasks_per_agent: null, max_run_seconds: null, max_tokens: null, max_auto_fixes: null, max_attempts: null, max_rework_rounds: null, max_child_depth: null, max_children_per_task: null, max_cost: null, currency: null, auto_accept_low_risk: false };
async function fixture(route: Route): Promise<Fixture> {
  const routeKey = `${route.method} ${route.path}`;
  if (route.secondPress === 'sensitive-draft') {
    const draft = randomUUID();
    await sql`INSERT INTO registry_records (id, kind, authority, status, scope_type, category, problem, decision, reuse, source, created_by) VALUES (${draft}, 'decision', 'owner', 'draft', 'global', 'security', 'Bench question', 'Bench answer', 'once', 'owner_message', ${jsonb({ type: 'owner', id: owner })}::text::jsonb)`;
    const register = async () => {
      const response = await fetch(`${base}/registry/drafts/${draft}/presses`, { method: 'POST', headers: { authorization: `Bearer afk_relay_${relaySecret}`, 'idempotency-key': randomUUID() } });
      assert.equal(response.status, 201);
      return (await response.json() as { press_id: string }).press_id;
    };
    return { path: `/registry/drafts/${draft}/confirm`, body: { press_id: await register(), telegram_user_id: 42 }, secondBody: { press_id: await register(), telegram_user_id: 42 } };
  }
  if (routeKey === 'PUT /projects/{id}/policy') {
    // A fresh project per fixture: the policy version is per project, and the shared one already has a policy after earlier tests.
    const fresh = randomUUID();
    await sql`INSERT INTO projects (id, name, repository_url, default_branch, workspace_policy) VALUES (${fresh}, ${'Policy bench ' + fresh},${'https://example.test/' + fresh + '.git'}, 'main', 'worktree')`;
    const path = `/projects/${fresh}/policy`;
    const first = await call(route, { path, body: policy, headers: { 'if-match': '"0"' } }, randomUUID());
    assert.equal(first.status, 201, JSON.stringify(first.body));
    return { path, body: { ...policy, allowed_commands: ['fixture-command'] }, headers: { 'if-match': '"1"' } };
  }
  if (routeKey === 'POST /tasks/{id}/cleanup') return { path: `/tasks/${await task('ACCEPTED')}/cleanup?dry_run=false&force=true` };
  if (routeKey === 'POST /devices') return { path: '/devices', body: { name: 'Bench device', platform: 'android' } };
  if (routeKey === 'POST /system/stop-all') return { path: '/system/stop-all' };
  if (routeKey === 'POST /conversations/{id}/polls/{poll_id}/answer') {
    const taskId = await task(), conversation = randomUUID(), poll = randomUUID();
    await repo.conversations.create({ id: conversation, source: 'factory', state: 'active', title: 'Bench', taskId });
    const message = await repo.messages.append({ id: randomUUID(), conversationId: conversation, sourceKey: poll, kind: 'question', author: 'system', body: 'Reject?', taskId, attachmentIds: [] });
    await repo.polls.create({ id: poll, messageId: message.id, conversationId: conversation, taskId, revisionNumber: 1, sourceKey: poll, arbiter: 'api', state: 'open', options: [{ key: 'reject', label: 'Reject', recommended: false }] });
    return { path: `/conversations/${conversation}/polls/${poll}/answer`, body: { answer_key: 'reject' } };
  }
  if (/^POST \/tasks\/\{id\}\/(reject|cancel|force-close)$/.test(routeKey)) {
    const suffix = route.path.split('/').at(-1);
    return { path: `/tasks/${await task()}/${suffix}`, body: { reason: 'Bench', ...(suffix === 'reject' ? { revision_number: 1 } : {}) } };
  }
  const regulation = /^POST \/regulation\/versions\/\{id\}\/(activate|revoke)$/.exec(routeKey);
  if (regulation) {
    // A regulation version in the state the operation needs: a draft to activate, an active one (activated through the API) to revoke.
    const created = await call(route, { path: '/regulation/versions', body: { clauses: [] } }, randomUUID(), undefined, 'POST');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const path = `/regulation/versions/${created.body.id}/activate`;
    if (regulation[1] === 'revoke') {
      const first = await call(route, { path }, randomUUID(), undefined, 'POST');
      assert.equal(first.status, 409, JSON.stringify(first.body));
      const second = await call(route, { path }, randomUUID(), `${first.body.confirmation_id}.${first.body.nonce}`, 'POST');
      assert.equal(second.status, 200, JSON.stringify(second.body));
    }
    return { path: `/regulation/versions/${created.body.id}/${regulation[1]}` };
  }
  // Newly registered routes are exercised immediately; a failing assertion identifies any additional domain fixture needed.
  return { path: route.path.replace(/\{[^}]+\}/g, () => randomUUID()), ...(route.request === 'none' ? {} : { body: {} }) };
}

for (const route of covered) test(`second press: ${route.method} ${route.path}`, async () => {
  const input = await fixture(route), key = randomUUID();
  const first = await call(route, input, key);
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.code, 'confirmation_required');
  const token = `${first.body.confirmation_id}.${first.body.nonce}`;
  const confirmed = input.secondBody ? { ...input, body: input.secondBody } : input;
  const second = await call(route, confirmed, input.secondBody ? randomUUID() : key, token);
  assert.ok(second.status >= 200 && second.status < 300, JSON.stringify(second.body));
  const replay = await call(route, confirmed, randomUUID(), token);
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
});

for (const route of covered) for (const source of ['record', 'grant'] as const) test(`permission-second-press: ${source}, ${route.method} ${route.path}`, async () => {
  const right = { action: `${route.method} ${route.path}`, target: 'bench', conditions: {} };
  const session = randomUUID();
  if (source === 'record') {
    const id = randomUUID();
    await sql`INSERT INTO registry_records(id,kind,authority,source,status,scope_type,project_id,reuse,"right") VALUES (${id},'permission','owner','owner_button','draft','project',${project},'standing',${jsonb(right)}::text::jsonb)`;
    await sql`UPDATE registry_records SET status='active' WHERE id=${id}`;
  } else {
    const request = randomUUID(), requestHash = randomUUID();
    await repo.transaction(async tx => {
      await tx.rightRequests.create({ id: request, sessionRef: session, action: right.action, target: right.target, conditions: right.conditions, reason: 'bench', tried: 'bench', requestHash, handlingTaskId: '00000000-0000-4000-8000-000000000008' });
      await tx.rightAnswers.create({ id: randomUUID(), requestId: request, step: 1, stepKind: 'code', answer: 'call_owner' });
      const confirmation = await issueConfirmation(tx, { actorId: owner, channel: 'api', deviceSessionId: null, operation: 'right.answer', targetType: 'right_request', targetId: request, requestHash }, new Date()); // the grant trigger compares expires_at with the database now(), so the window must start now, not at module load
      await tx.rightAnswers.create({ id: randomUUID(), requestId: request, step: 2, stepKind: 'owner', answer: 'grant', ownerActRef: confirmation.confirmation_id, answeredBy: { type: 'owner', id: owner } });
    });
  }
  if (source === 'record') await repo.conversations.forHubSession({ id: randomUUID(), sessionRef: session, projectId: project, state: 'active', title: 'Rights bench' });
  const registrySecret = randomUUID(), prefix = randomUUID();
  await repo.tokens.create({ id: randomUUID(), role: 'registry', sessionRef: session, prefix, tokenHash: createHash('sha256').update(registrySecret).digest('hex') });
  const checked = await fetch(base + '/rights/check', { method: 'POST', headers: { authorization: `Bearer afk_${prefix}_${registrySecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session, action: right.action, target: { target: right.target, conditions: right.conditions } }) });
  assert.equal(checked.status, 200);
  assert.equal((await checked.json() as { source: string }).source, source);
  const first = await call(route, await fixture(route), randomUUID());
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.code, 'confirmation_required');
});
