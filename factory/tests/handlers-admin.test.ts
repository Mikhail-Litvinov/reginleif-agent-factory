import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from '../db/migrate.ts';
import { createRepo, type Repo } from '../db/repo/index.ts';
import { createApiServer } from '../api/server.ts';
import { registerAdminHandlers } from '../api/handlers/index.ts';
import { confirmWindowSeconds, pageLimits, tokenOverlapSeconds } from '../api/handlers/settings.ts';
import { routes } from '../contracts/routes.ts';
import { connectBench, databaseBench } from './database-bench.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const benchPromise = databaseBench(import.meta.url);
// A fixed handler clock; the real server clock only checks token expiry, which is far away.
const clockNow = new Date();

type Json = Record<string, any>;
type Credential = { header: string; prefix: string; secret: string };
const ownerId = randomUUID();
const workerId = randomUUID();
const projectId = randomUUID();
const acceptedTask = randomUUID();
const runningTask = randomUUID();
const artifactLog = randomUUID();
const artifactPending = randomUUID();
const runId = randomUUID();
const executionId = randomUUID();
const workspaceId = randomUUID();

let client: ReturnType<typeof connectBench>;
let repo: Repo;
let closed: () => Promise<void>;
let off: string;
let on: string;
let stale: string;
let owner: Credential;
let worker: Credential;
let reader: Credential;

const credential = async (role: string, extra: Json = {}): Promise<Credential> => {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  await repo.tokens.create({ id: randomUUID(), name: role, role, prefix, tokenHash: sha(secret), ...extra });
  return { header: `Bearer afk_${prefix}_${secret}`, prefix, secret };
};

async function call(base: string, method: string, path: string, who: Credential | null, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (who) headers.authorization = who.header;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const result = await fetch(base + path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await result.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { /* event streams are plain text */ }
  return { status: result.status, json, text, headers: result.headers };
}

before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  client = connectBench(bench.migratorUrl);
  repo = createRepo(drizzle(client));
  await client`INSERT INTO owners (id, name) VALUES (${ownerId}, 'owner')`;
  await client`INSERT INTO workers (id, name, platform, status, concurrency_limit) VALUES (${workerId}, 'bootstrap', 'linux', 'online', 1)`;
  await client`INSERT INTO projects (id, name, repository_url, default_branch, workspace_policy) VALUES (${projectId}, 'handlers-admin', 'https://example.test/repo.git', 'main', 'worktree')`;
  await client`INSERT INTO tasks (id, project_id, status, depth, workflow_id, origin_type) VALUES (${acceptedTask}, ${projectId}, 'ACCEPTED', 0, ${'task-' + acceptedTask}, 'owner')`;
  await client`INSERT INTO tasks (id, project_id, status, depth, workflow_id, origin_type) VALUES (${runningTask}, ${projectId}, 'RUNNING', 0, ${'task-' + runningTask}, 'owner')`;
  await client`INSERT INTO task_runs (id, task_id, attempt_number, role, status, execution_id) VALUES (${runId}, ${acceptedTask}, 1, 'implementer', 'finished', ${executionId})`;
  await client`INSERT INTO task_artifacts (id, task_id, run_id, artifact_type, storage_backend, storage_key, size, upload_state) VALUES (${artifactLog}, ${acceptedTask}, ${runId}, 'log', 'fs', ${'k-' + artifactLog}, 1234, 'confirmed')`;
  await client`INSERT INTO task_artifacts (id, task_id, run_id, artifact_type, storage_backend, storage_key, size, upload_state) VALUES (${artifactPending}, ${acceptedTask}, ${runId}, 'result', 'fs', ${'k-' + artifactPending}, NULL, 'pending')`;
  await client`INSERT INTO workspaces (id, task_id, worker_id, repository, state) VALUES (${workspaceId}, ${acceptedTask}, ${workerId}, 'repo', 'done')`;
  for (const n of [1, 2, 3]) {
    await client`INSERT INTO task_events (id, task_id, event_type, actor_type, dedupe_key) VALUES (${randomUUID()}, ${acceptedTask}, 'seed_event', 'system', ${'seed-' + n})`;
  }
  owner = await credential('owner', { ownerId });
  worker = await credential('worker', { workerId });
  reader = await credential('reader');

  // xids are cluster-wide, so open transactions of concurrently running test databases hold the real snapshot
  // horizon back and would hide freshly committed rows from the stream pages. Same technique as repo-c.test.ts:
  // the handlers see a horizon above everything this database has committed.
  const streamRepo: Repo = { ...repo, audit: { ...repo.audit, snapshotXmin: async () => String((await client`SELECT (pg_current_xact_id()::text::bigint + 1)::text AS horizon`)[0]!.horizon) } };
  const servers = [
    { deps: { repo: streamRepo, queueGatewayEnabled: false, now: () => clockNow }, set: (url: string) => { off = url; } },
    { deps: { repo: streamRepo, queueGatewayEnabled: true, now: () => clockNow }, set: (url: string) => { on = url; } },
    // A repository whose token reads report a stale row_version, to provoke a lost version race.
    { deps: { repo: { ...repo,
      tokens: { ...repo.tokens, get: async (id: string) => { const row = await repo.tokens.get(id); return row && { ...row, rowVersion: row.rowVersion - 1n }; } },
      workers: { ...repo.workers, get: async (id: string) => { const row = await repo.workers.get(id); return row && { ...row, rowVersion: row.rowVersion - 1n }; } },
    } as Repo, now: () => clockNow }, set: (url: string) => { stale = url; } },
  ];
  const running: ReturnType<typeof createApiServer>[] = [];
  for (const { deps, set } of servers) {
    const api = createApiServer({ tokens: repo.tokens });
    registerAdminHandlers(api, deps);
    const address = await api.listen(0);
    set(`http://127.0.0.1:${address.port}`);
    running.push(api);
  }
  closed = async () => { for (const api of running) await api.close(); };
});

after(async () => {
  await closed?.();
  await client?.end();
});

test('the documented settings default to named values and are read from settings', async () => {
  // api.md names the four settings but gives no values; the defaults are named constants in settings.ts.
  assert.deepEqual(await pageLimits(repo), { defaultLimit: 50, maxLimit: 100 });
  assert.equal(await tokenOverlapSeconds(repo), 60);
  assert.equal(await confirmWindowSeconds(repo), 60);
  await repo.settings.set('page.maxLimit', 7, null);
  await repo.settings.set('page.defaultLimit', 3, null);
  try { assert.deepEqual(await pageLimits(repo), { defaultLimit: 3, maxLimit: 7 }); }
  finally {
    await repo.settings.set('page.maxLimit', 100, null);
    await repo.settings.set('page.defaultLimit', 50, null);
  }
});

test('no route outside contracts/routes.ts is registered, and none is a settings route', () => {
  const seen: string[] = [];
  const probe = createApiServer({ tokens: repo.tokens });
  registerAdminHandlers({ register(method, path, handler) { seen.push(`${method} ${path}`); probe.register(method, path, handler); } }, { repo });
  const listed = new Set(routes.map(route => `${route.method} ${route.path}`));
  for (const entry of seen) assert.ok(listed.has(entry), `unlisted route ${entry}`);
  assert.equal(new Set(seen).size, seen.length, 'a route is registered twice');
  assert.ok(seen.every(entry => !entry.includes('settings')));
});

test('a created token is returned once and only its hash is stored', async () => {
  const key = { 'idempotency-key': 'create-key-0001' };
  const body = { name: 'ci', role: 'reader' };
  const created = await call(off, 'POST', '/tokens', owner, { body, headers: key });
  assert.equal(created.status, 201);
  const parts = /^afk_([0-9a-f]{12})_(.+)$/.exec(created.json.secret as string);
  assert.ok(parts, 'secret has the afk_<prefix>_<secret> form');
  const [, prefix, secret] = parts;
  const row = (await client`SELECT * FROM api_tokens WHERE id = ${created.json.id}`)[0]!;
  assert.equal(row.prefix, prefix);
  assert.equal(row.token_hash, sha(secret!));
  assert.ok(!JSON.stringify(row).includes(secret!));
  // The plain secret must be in no column of any table (audit details and idempotency responses included).
  const tables = await client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  for (const { table_name } of tables) {
    const hits = await client`SELECT count(*)::int AS n FROM ${client(table_name as string)} t WHERE t::text LIKE ${'%' + secret + '%'}`;
    assert.equal(hits[0]!.n, 0, `secret stored in ${String(table_name)}`);
  }
  assert.ok(!('token_hash' in created.json));
  const listed = await call(off, 'GET', '/tokens', owner);
  assert.equal(listed.status, 200);
  assert.ok((listed.json.items as Json[]).some(item => item.id === created.json.id));
  assert.ok(!listed.text.includes(secret!));
  assert.ok(!listed.text.includes('token_hash'));
  assert.ok(!listed.text.includes('"secret"'));
  // The same key does not mint a second secret, and a different body under the key is a conflict.
  const replay = await call(off, 'POST', '/tokens', owner, { body, headers: key });
  assert.equal(replay.status, 409);
  assert.equal(replay.json.code, 'token_already_issued');
  assert.ok(!replay.text.includes(secret!));
  const conflict = await call(off, 'POST', '/tokens', owner, { body: { name: 'other', role: 'reader' }, headers: key });
  assert.equal(conflict.json.code, 'idempotency_conflict');
  // The secret authenticates a reader route.
  assert.equal((await call(off, 'GET', '/agents', { header: `Bearer ${created.json.secret}`, prefix: prefix!, secret: secret! })).status, 200);
});

test('token creation validates its inputs and needs an idempotency key', async () => {
  assert.equal((await call(off, 'POST', '/tokens', owner, { body: { name: 'x', role: 'reader' } })).status, 422);
  const headers = () => ({ 'idempotency-key': `key-${randomUUID()}` });
  assert.equal((await call(off, 'POST', '/tokens', owner, { body: { name: 'w', role: 'worker', worker_id: randomUUID() }, headers: headers() })).status, 422);
  assert.equal((await call(off, 'POST', '/tokens', owner, { body: { name: 'r', role: 'registry' }, headers: headers() })).status, 422);
  assert.equal((await call(off, 'POST', '/tokens', reader, { body: { name: 'x', role: 'reader' }, headers: headers() })).status, 403);
});

test('rotation keeps the old token valid for the overlap window; revocation ends a token', async () => {
  const made = await call(off, 'POST', '/tokens', owner, { body: { name: 'rot', role: 'reader' }, headers: { 'idempotency-key': 'rotate-make-0001' } });
  const first = /^afk_([0-9a-f]{12})_(.+)$/.exec(made.json.secret as string)!;
  const firstCred = { header: `Bearer ${made.json.secret}`, prefix: first[1]!, secret: first[2]! };
  const rotateKey = { 'idempotency-key': 'rotate-run-0001' };
  assert.equal((await call(off, 'POST', `/tokens/${made.json.id}/rotate`, owner)).status, 422);
  const rotated = await call(off, 'POST', `/tokens/${made.json.id}/rotate`, owner, { headers: rotateKey });
  assert.equal(rotated.status, 201);
  assert.notEqual(rotated.json.secret, made.json.secret);
  const old = await repo.tokens.get(made.json.id as string);
  assert.equal(old?.validUntil?.getTime(), clockNow.getTime() + 60_000);
  assert.equal((await call(off, 'GET', '/agents', firstCred)).status, 200);
  const next = /^afk_([0-9a-f]{12})_(.+)$/.exec(rotated.json.secret as string)!;
  const nextCred = { header: `Bearer ${rotated.json.secret}`, prefix: next[1]!, secret: next[2]! };
  assert.equal((await call(off, 'GET', '/agents', nextCred)).status, 200);
  assert.equal((await call(off, 'POST', `/tokens/${made.json.id}/rotate`, owner, { headers: rotateKey })).json.code, 'token_already_issued');

  const revokeKey = { 'idempotency-key': 'revoke-run-0001' };
  assert.equal((await call(off, 'DELETE', `/tokens/${rotated.json.id}`, owner)).status, 422);
  const revoked = await call(off, 'DELETE', `/tokens/${rotated.json.id}`, owner, { headers: revokeKey });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.revoked_at);
  assert.equal((await call(off, 'GET', '/agents', nextCred)).status, 401);
  const again = await call(off, 'DELETE', `/tokens/${rotated.json.id}`, owner, { headers: revokeKey });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal((await call(off, 'DELETE', `/tokens/${randomUUID()}`, owner, { headers: { 'idempotency-key': 'revoke-none-0001' } })).status, 404);
});

test('a lost row_version race rolls the idempotency claim back so the key can be retried', async () => {
  const made = await call(off, 'POST', '/tokens', owner, { body: { name: 'race', role: 'reader' }, headers: { 'idempotency-key': 'race-make-0001' } });
  const key = { 'idempotency-key': 'race-rotate-0001' };
  const lost = await call(stale, 'POST', `/tokens/${made.json.id}/rotate`, owner, { headers: key });
  assert.equal(lost.status, 409);
  assert.equal(lost.json.code, 'version_conflict');
  assert.equal(lost.json.current_row_version, 1);
  const retried = await call(off, 'POST', `/tokens/${made.json.id}/rotate`, owner, { headers: key });
  assert.equal(retried.status, 201);
  const lostRevoke = await call(stale, 'DELETE', `/tokens/${retried.json.id}`, owner, { headers: { 'idempotency-key': 'race-revoke-0001' } });
  assert.equal(lostRevoke.json.code, 'version_conflict');
  assert.equal(lostRevoke.json.current_row_version, 1);
  assert.equal((await call(off, 'DELETE', `/tokens/${retried.json.id}`, owner, { headers: { 'idempotency-key': 'race-revoke-0001' } })).status, 200);
});

test('second-machine-refused: a second machine needs the queue gateway; never a 403', async () => {
  const machine = (id: string) => ({ machine_id: id, name: id, platform: 'linux', capabilities: {}, version: '1.0.0', contract_version: 1 });
  const first = await call(off, 'POST', '/workers/register', worker, { body: machine('machine-a') });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.contract_range, { min: '1', max: '1' });
  const again = await call(off, 'POST', '/workers/register', worker, { body: machine('machine-a') });
  assert.equal(again.status, 200);
  assert.equal(again.json.worker_id, first.json.worker_id);
  // Registration updates the worker the token was issued for and binds it to its machine; it never adds a row.
  assert.equal(first.json.worker_id, workerId);
  assert.equal((await client`SELECT count(*)::int AS n FROM workers`)[0]!.n, 1);
  assert.equal((await client`SELECT machine_id FROM workers WHERE id = ${workerId}`)[0]!.machine_id, 'machine-a');
  // A token stays bound to its one machine.
  const rebound = await call(off, 'POST', '/workers/register', worker, { body: machine('machine-b') });
  assert.equal(rebound.status, 409);
  assert.equal(rebound.json.code, 'machine_mismatch');
  assert.equal((await client`SELECT count(*)::int AS n FROM workers`)[0]!.n, 1);
  // A second worker token: its own row, never a second row for a machine another worker holds.
  const secondId = randomUUID();
  await client`INSERT INTO workers (id, name, platform, status, concurrency_limit) VALUES (${secondId}, 'second', 'linux', 'online', 1)`;
  const second = await credential('worker', { workerId: secondId });
  const taken = await call(on, 'POST', '/workers/register', second, { body: machine('machine-a') });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, 'machine_conflict');
  const refused = await call(off, 'POST', '/workers/register', second, { body: machine('machine-b') });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'queue_isolation_required');
  assert.equal((await client`SELECT count(*)::int AS n FROM workers WHERE machine_id = 'machine-b'`)[0]!.n, 0);
  const allowed = await call(on, 'POST', '/workers/register', second, { body: machine('machine-b') });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.worker_id, secondId);
  assert.equal((await call(on, 'POST', '/workers/register', second, { body: machine('machine-b') })).json.worker_id, secondId);
  assert.equal((await client`SELECT count(*)::int AS n FROM workers`)[0]!.n, 2);
  assert.equal((await client`SELECT machine_id FROM workers WHERE id = ${secondId}`)[0]!.machine_id, 'machine-b');
  assert.equal((await client`SELECT count(*)::int AS n FROM audit_log WHERE action = 'worker.register'`)[0]!.n, 4);
});

test('heartbeat is for the worker own id only and is audited', async () => {
  const other = (await client`SELECT id FROM workers WHERE machine_id = 'machine-b'`)[0]!.id as string;
  const own = await call(off, 'POST', `/workers/${workerId}/heartbeat`, worker, { body: { run_ids: [] } });
  assert.equal(own.status, 200);
  assert.ok(own.json.server_time);
  assert.equal((await client`SELECT count(*)::int AS n FROM audit_log WHERE action = 'worker.heartbeat' AND target_id = ${workerId}`)[0]!.n, 1);
  assert.equal((await call(off, 'POST', `/workers/${other}/heartbeat`, worker, { body: { run_ids: [] } })).status, 403);
  assert.equal((await client`SELECT count(*)::int AS n FROM audit_log WHERE action = 'worker.heartbeat' AND target_id = ${other}`)[0]!.n, 0);
});

test('workers list, read and patch', async () => {
  const listed = await call(off, 'GET', '/workers', reader);
  assert.equal(listed.status, 200);
  assert.ok((listed.json.items as Json[]).some(item => item.id === workerId));
  assert.equal((await call(off, 'GET', `/workers/${randomUUID()}`, reader)).status, 404);
  const patched = await call(off, 'PATCH', `/workers/${workerId}`, owner, { body: { status: 'disabled', concurrency_limit: 4 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, 'disabled');
  assert.equal(patched.json.concurrency_limit, 4);
  const disabled = await call(off, 'GET', '/workers?status=disabled', reader);
  assert.deepEqual((disabled.json.items as Json[]).map(item => item.id), [workerId]);
  assert.equal((await call(off, 'PATCH', `/workers/${workerId}`, owner, { body: { status: 'online' } })).json.status, 'online');
  const lost = await call(stale, 'PATCH', `/workers/${workerId}`, owner, { body: { status: 'disabled' } });
  assert.equal(lost.status, 409);
  assert.equal(lost.json.code, 'version_conflict');
  assert.equal(lost.json.current_row_version, (await repo.workers.get(workerId))?.rowVersion);
});

test('cleanup dry run reports unknown sizes as null, not zero', async () => {
  const plan = await call(off, 'POST', `/tasks/${acceptedTask}/cleanup`, owner);
  assert.equal(plan.status, 200);
  assert.equal(plan.json.dry_run, true);
  const items = plan.json.items as Json[];
  assert.deepEqual(items.find(item => item.ref === artifactLog), { kind: 'log', ref: artifactLog, size: 1234 });
  assert.deepEqual(items.find(item => item.ref === artifactPending), { kind: 'artifact', ref: artifactPending, size: null });
  assert.deepEqual(items.find(item => item.kind === 'execution_folder'), { kind: 'execution_folder', ref: executionId, size: null });
  assert.deepEqual(items.find(item => item.kind === 'worktree'), { kind: 'worktree', ref: workspaceId, size: null });
  assert.equal(plan.json.total_size, 1234);
  assert.equal((await call(off, 'POST', `/tasks/${runningTask}/cleanup`, owner)).json.code, 'task_active');
  assert.equal((await call(off, 'POST', `/tasks/${randomUUID()}/cleanup`, owner)).status, 404);
});

test('cleanup runs once per key and force needs a second press within the confirmation window', async () => {
  const path = `/tasks/${acceptedTask}/cleanup?dry_run=false`;
  assert.equal((await call(off, 'POST', path, owner)).status, 422);
  const key = { 'idempotency-key': 'cleanup-plain-0001' };
  const first = await call(off, 'POST', path, owner, { headers: key });
  assert.equal(first.status, 202);
  assert.equal(first.json.delivery_state, 'recorded');
  const replay = await call(off, 'POST', path, owner, { headers: key });
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replay.json.id, first.json.id);
  assert.equal((await client`SELECT count(*)::int AS n FROM outbox_events WHERE kind = 'cleanup' AND task_id = ${acceptedTask}`)[0]!.n, 1);

  const forced = `/tasks/${acceptedTask}/cleanup?dry_run=false&force=true`;
  const forceKey = { 'idempotency-key': 'cleanup-force-0001' };
  const asked = await call(off, 'POST', forced, owner, { headers: forceKey });
  assert.equal(asked.status, 409);
  assert.equal(asked.json.code, 'confirmation_required');
  assert.equal(asked.json.expires_at, new Date(clockNow.getTime() + 60_000).toISOString());
  assert.equal((await call(off, 'POST', forced, owner, { headers: { ...forceKey, 'x-confirm': `${asked.json.confirmation_id}.wrong-nonce` } })).json.code, 'confirmation_invalid');
  const confirm = `${asked.json.confirmation_id}.${asked.json.nonce}`;
  const done = await call(off, 'POST', forced, owner, { headers: { ...forceKey, 'x-confirm': confirm } });
  assert.equal(done.status, 202);
  // A confirmation is single use.
  assert.equal((await call(off, 'POST', forced, owner, { headers: { 'idempotency-key': 'cleanup-force-0002', 'x-confirm': confirm } })).json.code, 'confirmation_invalid');

  await repo.settings.set('confirm.windowSeconds', 120, null);
  try {
    const wider = await call(off, 'POST', forced, owner, { headers: { 'idempotency-key': 'cleanup-force-0003' } });
    assert.equal(wider.json.expires_at, new Date(clockNow.getTime() + 120_000).toISOString());
  } finally { await repo.settings.set('confirm.windowSeconds', 60, null); }
});

test('task events page by cursor and honour the page-limit settings', async () => {
  const path = `/tasks/${acceptedTask}/events?type=seed_event`;
  const all = await call(off, 'GET', path, reader);
  assert.equal(all.status, 200);
  assert.equal((all.json.items as Json[]).length, 3);
  const page = await call(off, 'GET', `${path}&limit=2`, reader);
  assert.equal((page.json.items as Json[]).length, 2);
  const rest = await call(off, 'GET', `${path}&limit=2&cursor=${page.json.next_cursor}`, reader);
  assert.equal((rest.json.items as Json[]).length, 1);
  assert.equal((await call(off, 'GET', `${path}&cursor=not-a-cursor`, reader)).json.code, 'bad_cursor');
  assert.equal((await call(off, 'GET', `/tasks/${randomUUID()}/events`, reader)).status, 404);
  await repo.settings.set('page.maxLimit', 2, null);
  await repo.settings.set('page.defaultLimit', 1, null);
  try {
    assert.equal(((await call(off, 'GET', path, reader)).json.items as Json[]).length, 1);
    assert.equal(((await call(off, 'GET', `${path}&limit=100`, reader)).json.items as Json[]).length, 2);
  } finally {
    await repo.settings.set('page.maxLimit', 100, null);
    await repo.settings.set('page.defaultLimit', 50, null);
  }
});

test('audit list filters and pages by cursor', async () => {
  const everything = await call(off, 'GET', '/system/audit', owner);
  assert.equal(everything.status, 200);
  const rows = everything.json.items as Json[];
  assert.ok(rows.length >= 3);
  assert.ok(rows.every(row => !('request_hash' in row) && !('commit_xid' in row)));
  const page = await call(off, 'GET', '/system/audit?limit=2', owner);
  assert.equal((page.json.items as Json[]).length, 2);
  const next = await call(off, 'GET', `/system/audit?limit=2&cursor=${page.json.next_cursor}`, owner);
  assert.ok((next.json.items as Json[]).length > 0);
  const firstIds = new Set((page.json.items as Json[]).map(row => row.id));
  assert.ok((next.json.items as Json[]).every(row => !firstIds.has(row.id)));
  const filtered = await call(off, 'GET', '/system/audit?action=token.create', owner);
  assert.ok((filtered.json.items as Json[]).length > 0);
  assert.ok((filtered.json.items as Json[]).every(row => row.action === 'token.create'));
  assert.equal((await call(off, 'GET', '/system/audit?cursor=garbage', owner)).json.code, 'bad_cursor');
  assert.equal((await call(off, 'GET', '/system/audit', reader)).status, 403);
});

test('agents: create, version-checked patch and soft delete', async () => {
  const created = await call(off, 'POST', '/agents', owner, { body: { name: 'agent-one', provider: 'codex', adapter_type: 'cli' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.concurrency_limit, 1);
  assert.equal(created.json.enabled, true);
  const path = `/agents/${created.json.id}`;
  assert.equal((await call(off, 'PATCH', path, owner, { body: { concurrency_limit: 3 } })).status, 422);
  const stale = await call(off, 'PATCH', path, owner, { body: { concurrency_limit: 3 }, headers: { 'if-match': '"999"' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'version_conflict');
  assert.equal(stale.json.current_row_version, created.json.row_version);
  const patched = await call(off, 'PATCH', path, owner, { body: { concurrency_limit: 3 }, headers: { 'if-match': `"${created.json.row_version}"` } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.concurrency_limit, 3);
  assert.ok(patched.json.row_version > created.json.row_version);
  assert.equal((await call(off, 'DELETE', path, owner)).status, 422);
  const removed = await call(off, 'DELETE', path, owner, { headers: { 'if-match': `"${patched.json.row_version}"` } });
  assert.equal(removed.status, 200);
  const listed = await call(off, 'GET', '/agents', reader);
  assert.ok(!(listed.json.items as Json[]).some(item => item.id === created.json.id));
  assert.equal((await call(off, 'GET', `/agents/${randomUUID()}`, reader)).status, 404);
  assert.equal((await call(off, 'POST', '/agents', reader, { body: { name: 'x', provider: 'codex', adapter_type: 'cli' } })).status, 403);
});

test('project policy can be written by an owner and read back', async () => {
  const body = {
    allowed_commands: ['npm test'], allowed_directories: ['.'], allowed_repositories: [], git_operations: ['commit'],
    confirmation_required: [], allowed_tools: [], network: {}, max_concurrent_tasks: null, max_tasks_per_agent: null,
    max_run_seconds: null, max_tokens: null, max_auto_fixes: null, max_attempts: null, max_rework_rounds: null,
    max_child_depth: null, max_children_per_task: null, max_cost: null, currency: null, auto_accept_low_risk: false,
  };
  assert.equal((await call(off, 'GET', `/projects/${projectId}/policy`, reader)).status, 404);
  // If-Match is the version being replaced: a project without a policy has version 0.
  assert.equal((await call(off, 'PUT', `/projects/${projectId}/policy`, owner, { body })).status, 422);
  const wrong = await call(off, 'PUT', `/projects/${projectId}/policy`, owner, { body, headers: { 'if-match': '"1"' } });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.code, 'version_conflict');
  assert.equal(wrong.json.current_row_version, 0);
  const put = await call(off, 'PUT', `/projects/${projectId}/policy`, owner, { body, headers: { 'if-match': '"0"' } });
  assert.equal(put.status, 201);
  const read = await call(off, 'GET', `/projects/${projectId}/policy`, reader);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.allowed_commands, ['npm test']);
  assert.equal((await call(off, 'PUT', `/projects/${randomUUID()}/policy`, owner, { body, headers: { 'if-match': '"0"' } })).status, 404);
});

test('policy loosening needs the second press, a tightening does not, every change is audited', async () => {
  const path = `/projects/${projectId}/policy`;
  const current = (await call(off, 'GET', path, reader)).json;
  const base = {
    allowed_commands: current.allowed_commands, allowed_directories: current.allowed_directories, allowed_repositories: current.allowed_repositories,
    git_operations: current.git_operations, confirmation_required: current.confirmation_required, allowed_tools: current.allowed_tools, network: current.network,
    max_concurrent_tasks: null, max_tasks_per_agent: null, max_run_seconds: null, max_tokens: null, max_auto_fixes: null, max_attempts: null,
    max_rework_rounds: null, max_child_depth: null, max_children_per_task: null, max_cost: null, currency: null, auto_accept_low_risk: false,
  };
  const version = Number(current.version);
  const count = async (action: string) => (await client`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action} AND target_id = ${projectId}`)[0]!.n as number;
  const versions = async () => (await client`SELECT count(*)::int AS n FROM execution_policies WHERE project_id = ${projectId}`)[0]!.n as number;

  // Tightening: a limit replaces "unlimited" and an allowed element is removed. No second press.
  const tight = { ...base, allowed_commands: [], max_tokens: 1000 };
  const tightened = await call(off, 'PUT', path, owner, { body: tight, headers: { 'if-match': `"${version}"` } });
  assert.equal(tightened.status, 201);
  assert.equal(await count('policy.create'), 2);
  assert.equal(await count('policy.loosen'), 0);

  // Loosening: an added allowed element and a raised limit.
  const loose = { ...tight, allowed_commands: ['make build-all'], max_tokens: 5000 };
  const header = { 'if-match': `"${version + 1}"` };
  const before = await versions();
  const first = await call(off, 'PUT', path, owner, { body: loose, headers: header });
  assert.equal(first.status, 409);
  assert.equal(first.json.code, 'confirmation_required');
  assert.equal(await versions(), before);
  const confirm = `${first.json.confirmation_id}.${first.json.nonce}`;
  // The press is bound to the request: another body, another version or another actor do not satisfy it.
  assert.equal((await call(off, 'PUT', path, owner, { body: { ...loose, max_tokens: 9000 }, headers: { ...header, 'x-confirm': confirm } })).json.code, 'confirmation_invalid');
  assert.equal(await versions(), before);
  const second = await call(off, 'PUT', path, owner, { body: loose, headers: { ...header, 'x-confirm': confirm } });
  assert.equal(second.status, 201);
  assert.equal(await versions(), before + 1);
  assert.equal(await count('policy.loosen'), 1);
  assert.equal(await count('policy.create'), 2);
  // A used press does not carry over to a new loosening (the repeated same body is no longer a loosening at all).
  const replay = await call(off, 'PUT', path, owner, { body: { ...loose, max_tokens: 9000 }, headers: { 'if-match': `"${version + 2}"`, 'x-confirm': confirm } });
  assert.equal(replay.json.code, 'confirmation_invalid');
  // A stale If-Match is a conflict before any press is asked.
  const stale409 = await call(off, 'PUT', path, owner, { body: { ...loose, max_tokens: 99999 }, headers: header });
  assert.equal(stale409.json.code, 'version_conflict');
  assert.equal(stale409.json.current_row_version, version + 2);
});
