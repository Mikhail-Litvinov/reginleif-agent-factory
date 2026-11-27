import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApiServer } from '../api/server.ts';
import { registerAllHandlers } from '../api/handlers/register-all.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo } from '../db/repo/index.ts';
import { connectBench, databaseBench } from './database-bench.ts';

// rights-suspended, routes side: who may read and restore a suspension. The suspension itself, the ended grants and the stop
// orders are written by the critical-right path of rights/blocks.ts and are tested with it.
const benchPromise = databaseBench(import.meta.url);
const [owner, project, task, worker, suspendedAgent, chiefAgent, suspendedRun, chiefRun, suspension] = Array.from({ length: 9 }, () => randomUUID());
const secrets = { owner: randomUUID(), chief: randomUUID(), suspended: randomUUID() };
const now = new Date('2030-01-01T00:00:00.000Z');
let admin: ReturnType<typeof connectBench>, connection: ReturnType<typeof connectBench>;
let api: ReturnType<typeof createApiServer>, base: string;

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const call = (method: string, path: string, prefix: string, secret: string, body?: unknown) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer afk_${prefix}_${secret}`, 'idempotency-key': randomUUID(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  admin = connectBench(bench.migratorUrl);
  connection = connectBench(bench.apiUrl);
  await admin`INSERT INTO owners (id, name, telegram_user_id) VALUES (${owner!}, 'Owner', 42)`;
  await admin`INSERT INTO projects(id,name) VALUES (${project!}, 'rights suspended bench')`;
  await admin`INSERT INTO workers (id, machine_id) VALUES (${worker!}, 'rights-suspended')`;
  await admin`INSERT INTO agents(id) VALUES (${suspendedAgent!}), (${chiefAgent!})`;
  await admin`INSERT INTO tasks(id,project_id,status,origin_type,depth,workflow_id) VALUES (${task!},${project!},'RUNNING','owner',0,${'task-' + task})`;
  // The run guard (migration 0007) admits a chief engineer run only for a task that handles a right request or is a BLOCKED
  // task handled by the chief engineer; the chief engineer here handles a request.
  await admin`INSERT INTO right_requests(id,task_id,handling_task_id,action,target) VALUES (${randomUUID()},${task!},${task!},'read','work')`;
  await admin`INSERT INTO task_runs(id,task_id,role,agent_id,worker_id,participant,status,execution_id) VALUES
    (${suspendedRun!},${task!},'implementer',${suspendedAgent!},${worker!},'builder','running',${randomUUID()}),
    (${chiefRun!},${task!},'chief_engineer',${chiefAgent!},${worker!},'chief','running',${randomUUID()})`;
  await admin`INSERT INTO rights_suspensions(id,agent_id,run_id,task_id,event_key,reason) VALUES (${suspension!},${suspendedAgent!},${suspendedRun!},${task!},${'event-' + suspension},'critical right')`;
  await admin`INSERT INTO api_tokens (id, role, owner_id, prefix, token_hash) VALUES (${randomUUID()}, 'owner', ${owner!}, 'owner', ${hash(secrets.owner)})`;
  await admin`INSERT INTO api_tokens (id, role, worker_id, run_id, prefix, token_hash) VALUES
    (${randomUUID()}, 'worker', ${worker!}, ${chiefRun!}, 'chief', ${hash(secrets.chief)}),
    (${randomUUID()}, 'worker', ${worker!}, ${suspendedRun!}, 'suspended', ${hash(secrets.suspended)})`;
  const repo = createRepo(drizzle(connection));
  api = createApiServer({ tokens: repo.tokens, clock: () => now });
  registerAllHandlers(api, repo, { now: () => now });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
after(async () => { await api?.close(); await connection?.end(); await admin?.end(); });

test('an open suspension is listed and readable by the owner', async () => {
  const one = await call('GET', `/rights/suspensions/${suspension}`, 'owner', secrets.owner);
  assert.equal(one.status, 200);
  const row = await one.json() as { id: string; state: string; restored_by: unknown };
  assert.deepEqual([row.id, row.state, row.restored_by], [suspension, 'open', null]);
  const list = await call('GET', '/rights/suspensions?state=open', 'owner', secrets.owner);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { items: Array<{ id: string }> }).items.map(item => item.id), [suspension]);
  assert.equal((await call('GET', `/rights/suspensions/${randomUUID()}`, 'owner', secrets.owner)).status, 404);
});

test('the suspended agent cannot restore itself, and the owner cannot restore a suspension of a non chief engineer', async () => {
  const body = { restore_reason: 'trying' };
  assert.equal((await call('POST', `/rights/suspensions/${suspension}/restore`, 'suspended', secrets.suspended, body)).status, 403);
  assert.equal((await call('POST', `/rights/suspensions/${suspension}/restore`, 'owner', secrets.owner, body)).status, 403);
  const [row] = await admin`SELECT ended_at FROM rights_suspensions WHERE id = ${suspension!}`;
  assert.equal(row!.ended_at, null);
});

test('the chief engineer restores the suspension once, with an audit row', async () => {
  const restored = await call('POST', `/rights/suspensions/${suspension}/restore`, 'chief', secrets.chief, { restore_reason: 'checked the cause' });
  assert.equal(restored.status, 200);
  const row = await restored.json() as { state: string; restored_by: string; restore_reason: string };
  assert.deepEqual([row.state, row.restored_by, row.restore_reason], ['restored', chiefRun, 'checked the cause']);
  const [stored] = await admin`SELECT ended_at, restore_audit_id FROM rights_suspensions WHERE id = ${suspension!}`;
  assert.notEqual(stored!.ended_at, null);
  const [audit] = await admin`SELECT action FROM audit_log WHERE id = ${stored!.restore_audit_id}`;
  assert.equal(audit!.action, 'rights.restore');
  const again = await call('POST', `/rights/suspensions/${suspension}/restore`, 'chief', secrets.chief, { restore_reason: 'again' });
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, 'request_closed');
});
