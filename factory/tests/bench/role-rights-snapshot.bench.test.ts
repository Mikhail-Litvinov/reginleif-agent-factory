import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from '../../db/migrate.ts';
import { createRepo, type Repo } from '../../db/repo/index.ts';
import { checkForSubject } from '../../rights/check.ts';
import { assignRole, profileRights, roleForParticipant } from '../../rights/roles.ts';
import { connectBench, databaseBench, jsonb } from '../database-bench.ts';

const bench = databaseBench(import.meta.url);
let sql: ReturnType<typeof connectBench>, repo: Repo;
const project = randomUUID(), task = randomUUID(), regulation = randomUUID(), role = randomUUID(), chief = randomUUID(), agent = randomUUID(), builder = randomUUID(), run = randomUUID();
const right = { action: 'POST /devices', target: 'work', conditions: {} };

before(async () => {
  const db = await bench;
  await migrate({ url: db.migratorUrl });
  sql = connectBench(db.migratorUrl);
  repo = createRepo(drizzle(sql));
  await sql`INSERT INTO projects(id,name) VALUES (${project},'role bench')`;
  await sql`INSERT INTO tasks(id,project_id,status,origin_type,depth,workflow_id) VALUES (${task},${project},'RUNNING','owner',0,${'task-' + task})`;
  await sql`INSERT INTO regulation_versions(id,number,status,clauses,clauses_bytes) VALUES (${regulation},1,'draft','[]',0)`;
  await sql`INSERT INTO roles(id,name,version,status,rights,deny,regulation_version_id) VALUES (${role},'bench-role',1,'draft',${jsonb([right])}::text::jsonb,'[]',${regulation})`;
  await sql`UPDATE regulation_versions SET status='active' WHERE id=${regulation}`;
  await sql`INSERT INTO agents(id) VALUES (${agent}),(${builder})`;
  await sql`INSERT INTO right_requests(id,task_id,handling_task_id,action,target) VALUES (${randomUUID()},${task},${task},'read','work')`;
  await sql`INSERT INTO task_runs(id,task_id,role,agent_id,participant,status,execution_id) VALUES (${chief},${task},'chief_engineer',${agent},'chief','running',${randomUUID()})`;
  await repo.transaction(tx => assignRole(tx, { taskId: task, participant: 'builder', roleId: role, engineerRunId: chief, participantRunId: randomUUID() }));
  await sql`INSERT INTO task_runs(id,task_id,role,agent_id,participant,status,execution_id) VALUES (${run},${task},'implementer',${builder},'builder','running',${randomUUID()})`;
});
after(async () => { await sql?.end(); });

test('role-rights: only the assigned participant obtains the role rights', async () => {
  const held = await repo.transaction(tx => roleForParticipant(tx, task, 'builder'));
  assert.equal((await repo.transaction(tx => roleForParticipant(tx, task, 'other'))), undefined);
  assert.ok(held);
  const subject = { projectId: project, taskId: task, participant: 'builder', agentId: builder, sessionRef: null };
  const check = (call: typeof right, participant = 'builder') => repo.transaction(tx => checkForSubject(tx, { ...subject, participant }, call, new Date(0)));
  assert.equal((await check(right)).source, 'role');
  assert.equal((await check({ ...right, target: 'other' })).allowed, false);
  assert.equal((await check(right, 'other')).allowed, false);
  await assert.rejects(repo.transaction(tx => assignRole(tx, { taskId: task, participant: 'chief', roleId: role, engineerRunId: chief, participantRunId: randomUUID() })));
  await assert.rejects(repo.transaction(tx => assignRole(tx, { taskId: task, participant: 'other', roleId: role, engineerRunId: run, participantRunId: randomUUID() })));
  await assert.rejects(sql`UPDATE roles SET rights='[]' WHERE id=${role}`);
});

test('rights-snapshot: only expressible role and grant rights are stored with their source', async () => {
  const grant = randomUUID(), run = randomUUID();
  const narrow = { ...right, target: 'single-file' };
  const once = { ...right, conditions: { once: true } };
  const profile = profileRights([right, narrow], [{ id: grant, right }, { id: randomUUID(), right: once }], value => value.target === 'work');
  await sql`INSERT INTO task_runs(id,task_id,role,profile_rights) VALUES (${run},${task},'implementer',${jsonb(profile)}::text::jsonb)`;
  const stored = (await repo.taskReads.getRun(run))?.profileRights;
  assert.deepEqual(stored, profile);
  assert.deepEqual(profile.map(value => value.source), ['role', grant]);
  assert.equal(profile.some(value => value.target === 'single-file'), false);
  assert.equal(profile.some(value => value.conditions && typeof value.conditions === 'object' && Reflect.get(value.conditions, 'once') === true), false);
});
