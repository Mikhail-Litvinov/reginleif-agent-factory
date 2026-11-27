import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from '../../db/migrate.ts';
import { createRepo, type Repo } from '../../db/repo/index.ts';
import { checkForSubject, checkRights } from '../../rights/check.ts';
import { standingTaskFor } from '../../rights/standing-task.ts';
import { issueConfirmation, verifyConfirmation } from '../../api/second-press.ts';
import { routes } from '../../contracts/routes.ts';
import { connectBench, databaseBench } from '../database-bench.ts';

const bench = databaseBench(import.meta.url);
let sql: ReturnType<typeof connectBench>, repo: Repo;
const project = randomUUID(), otherProject = randomUUID(), agent = randomUUID(), task = randomUUID(), record = randomUUID();
const now = new Date('2030-01-01T00:00:00.000Z');
const right = { action: 'POST /devices', target: 'bench-file', conditions: { variant: ['one'] } };
const subject = { projectId: project, taskId: task, participant: 'builder', agentId: agent, sessionRef: null };

before(async () => {
  const db = await bench;
  await migrate({ url: db.migratorUrl });
  sql = connectBench(db.migratorUrl);
  repo = createRepo(drizzle(sql));
  await sql`INSERT INTO projects(id,name) VALUES (${project}, 'rights bench'), (${otherProject}, 'other rights bench')`;
  await sql`INSERT INTO agents(id) VALUES (${agent})`;
  await sql`INSERT INTO tasks(id,project_id,status,origin_type,depth,workflow_id) VALUES (${task},${project},'RUNNING','owner',0,${'task-' + task})`;
  await sql`INSERT INTO registry_records(id,kind,authority,source,status,scope_type,project_id,reuse,"right") VALUES (${record},'permission','owner','owner_button','draft','project',${project},'once',${sql.json(right)})`;
  await sql`UPDATE registry_records SET status='active' WHERE id=${record}`;
});
after(async () => { await sql?.end(); });

test('permission-by-record: exact project and call, and one concurrent use', async () => {
  const check = (value: typeof right, projectId = project) => repo.transaction(tx => checkForSubject(tx, { ...subject, projectId }, value, now));
  assert.equal((await check({ ...right, target: 'other' })).source, 'none');
  assert.equal((await check({ ...right, conditions: { variant: ['two'] } })).source, 'none');
  assert.equal((await check(right, otherProject)).source, 'none');
  const results = await Promise.all([check(right), check(right)]);
  assert.deepEqual(results.map(result => result.source).sort(), ['none', 'record']);
  assert.equal((await check(right)).source, 'none');
});

test('permission-by-record: standing permission applies to a session; decisions do not', async () => {
  const session = { projectId: project, taskId: null, participant: null, agentId: null, sessionRef: 'bench-session' };
  const standing = randomUUID(), decision = randomUUID();
  const alternate = { ...right, target: 'another-file' };
  await sql`INSERT INTO registry_records(id,kind,authority,source,status,scope_type,project_id,reuse,"right") VALUES (${standing},'permission','owner','owner_button','draft','project',${project},'standing',${sql.json(alternate)})`;
  await sql`UPDATE registry_records SET status='active' WHERE id=${standing}`;
  await sql`INSERT INTO registry_records(id,kind,authority,source,status,scope_type,project_id,reuse,decision) VALUES (${decision},'decision','owner','owner_button','draft','project',${project},'standing','read another/file')`;
  await sql`UPDATE registry_records SET status='active' WHERE id=${decision}`;
  const check = (call: typeof right) => repo.transaction(tx => checkForSubject(tx, session, call, now));
  assert.equal((await check(alternate)).source, 'record');
  assert.equal((await check({ ...alternate, target: 'similar-file' })).source, 'none');
  assert.equal((await check(alternate)).source, 'record');
});

test('rights-suspended: suspension refuses before all sources, including unreadable calls', async () => {
  const run1 = randomUUID(), run2 = randomUUID();
  await sql`INSERT INTO task_runs(id,task_id,role,agent_id,execution_id,status,attempt_number) VALUES (${run1},${task},'implementer',${agent},${randomUUID()},'running',1), (${run2},${task},'tester',${agent},${randomUUID()},'running',2)`;
  await sql`INSERT INTO rights_suspensions(id,agent_id,event_key,reason) VALUES (${randomUUID()},${agent},${randomUUID()},'owner_stop')`;
  for (const call of [right, undefined]) {
    assert.deepEqual(await repo.transaction(tx => checkForSubject(tx, subject, call, now)), { allowed: false, source: 'refused', reason: 'suspended' });
  }
  await assert.rejects(sql`INSERT INTO rights_suspensions(id,agent_id,event_key) VALUES (${randomUUID()},${agent},${randomUUID()})`);
  const stops = await sql`SELECT payload->>'run_id' AS run_id FROM outbox_events WHERE kind='stop_run' AND payload->>'run_id' IN (${run1},${run2})`;
  assert.deepEqual(stops.map(row => row.run_id).sort(), [run1, run2].sort());
  await assert.rejects(sql`INSERT INTO task_runs(id,task_id,role,agent_id) VALUES (${randomUUID()},${task},'implementer',${agent})`);
});

test('standing-task: project and system lookup, and database guards', async () => {
  const owner = randomUUID(), standing = randomUUID();
  await sql`INSERT INTO owners(id,name) VALUES (${owner},'standing owner')`;
  await repo.tasks.createStanding({ id: standing, projectId: project, createdBy: owner, revisionId: randomUUID() });
  assert.equal(await standingTaskFor(repo.tasks, project), standing);
  assert.equal(await standingTaskFor(repo.tasks, null), '00000000-0000-4000-8000-000000000008');
  const systemTask = await repo.tasks.get('00000000-0000-4000-8000-000000000008');
  assert.equal(systemTask?.currentRevision, 1);
  assert.equal((await sql`SELECT id FROM task_revisions WHERE task_id=${systemTask!.id} AND revision_number=1`).length, 1);
  const request = randomUUID();
  await sql`INSERT INTO right_requests(id,session_ref,handling_task_id,action,target) VALUES (${request},'standing-session',${standing},'read','file')`;
  assert.equal((await repo.rightRequests.get(request))?.handlingTaskId, standing);
  assert.equal((await sql`SELECT id FROM outbox_events WHERE task_id=${standing} AND kind='start_workflow'`).length, 0);
  await assert.rejects(sql`UPDATE tasks SET status='ACCEPTED' WHERE id=${standing}`);
  await assert.rejects(sql`INSERT INTO workspaces(id,task_id) VALUES (${randomUUID()},${standing})`);
  await assert.rejects(sql`UPDATE tasks SET deleted_at=now() WHERE id=${standing}`);
  await assert.rejects(repo.tasks.createStanding({ id: randomUUID(), projectId: project, createdBy: owner, revisionId: randomUUID() }));
});

test('permission-second-press: marked operations retain scoped one-use confirmations', async () => {
  const owner = randomUUID();
  await sql`INSERT INTO owners(id,name) VALUES (${owner},'confirmation owner')`;
  await repo.settings.set('confirm.windowSeconds', 60, owner);
  for (const route of routes.filter(route => route.secondPress)) {
    for (const source of ['record', 'grant'] as const) {
      const call = { action: `${route.method} ${route.path}`, target: 'bench', conditions: {} };
      const result = await checkRights({ call, suspended: false, guard: false, deny: [], roles: [], records: source === 'record' ? [{ id: 'record', number: '1', right: call, once: false }] : [], grants: source === 'grant' ? [{ id: 'grant', right: call }] : [], consume: async () => false });
      assert.equal(result.source, source);
      const scope = { actorId: owner, channel: 'api', deviceSessionId: null, operation: call.action, targetType: 'bench', targetId: randomUUID(), requestHash: 'bench' };
      await repo.transaction(async tx => {
        const issued = await issueConfirmation(tx, scope, now);
        const token = `${issued.confirmation_id}.${issued.nonce}`;
        assert.ok(await verifyConfirmation(tx, token, scope, now));
        assert.equal(await verifyConfirmation(tx, token, scope, now), undefined);
      });
    }
  }
});
