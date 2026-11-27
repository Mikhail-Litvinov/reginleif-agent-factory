import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { routes } from '../contracts/routes.ts';
import { createApiServer } from '../api/server.ts';
import { createLogger } from '../lib/log.ts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from '../db/migrate.ts';
import { createRepo } from '../db/repo/index.ts';
import { connectBench, databaseBench } from './database-bench.ts';

const roles = ['owner', 'worker', 'relay', 'reader', 'registry', 'hub', 'device'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workerId = randomUUID();
const tokens = new Map(roles.map((role) => [hash(role), { id: randomUUID(), role, prefix: role, tokenHash: hash(role), workerId: role === 'worker' ? workerId : null, revokedAt: null, expiresAt: null, validUntil: null }]));
const lines: string[] = [];
const api = createApiServer({ tokens: { byHash: async (h) => tokens.get(h) }, authorizeScope: async () => true, logger: createLogger({ sink: (line) => lines.push(line) }) });
for (const route of routes) api.register(route.method, route.path, async () => ({ status: 204 }));
let base: string;
before(async () => { const address = await api.listen(0); assert.equal(address.address, '127.0.0.1'); base = `http://127.0.0.1:${address.port}`; });
after(async () => { await api.close(); });

test('api-authz-matrix', async () => {
  for (const route of routes) {
    const path = route.path.replace(/\{[^}]+\}/g, workerId);
    for (const role of [...roles, 'none']) {
      const allowed = route.roles.includes('none') || route.roles.some((r) => r.split(':')[0] === role);
      const response = await fetch(base + path, { method: route.method, headers: role === 'none' ? {} : { authorization: `Bearer afk_${role}_${role}` } });
      // Allowed requests may fail body validation or an ownership check; they passed role authentication.
      assert.equal(response.status === 401 || response.status === 403, !allowed, `${route.method} ${route.path} ${role}: ${response.status}`);
    }
  }
});

test('rejects revoked credentials and an invalid body; propagates request id', async () => {
  const requestId = randomUUID();
  // api.md validation rule: a malformed body is answered 422 validation_failed. The second-machine rule
  // (api.md:149, :676) lives in the workers handler and is tested in handlers-admin.test.ts.
  const response = await fetch(base + '/workers/register', { method: 'POST', headers: { authorization: 'Bearer afk_worker_worker', 'content-type': 'application/json', 'x-request-id': requestId }, body: JSON.stringify({ machine_id: 'second' }) });
  assert.equal(response.status, 422);
  assert.equal(response.headers.get('x-request-id'), requestId);
  assert.equal((await response.json() as { request_id: string }).request_id, requestId);
  assert.ok(lines.some((line) => line.includes(requestId)));
  const token = tokens.get(hash('reader'))!;
  token.revokedAt = new Date() as never;
  try { assert.equal((await fetch(base + '/projects', { headers: { authorization: 'Bearer afk_reader_reader' } })).status, 401); }
  finally { token.revokedAt = null; }
});

test('repository token authentication on the database bench', async () => {
  const bench = await databaseBench(import.meta.url);
  await migrate({ url: bench.migratorUrl });
  const client = connectBench(bench.migratorUrl);
  const repo = createRepo(drizzle(client));
  const server = createApiServer({ tokens: repo.tokens });
  try {
    const secret = randomUUID();
    const id = randomUUID();
    await repo.tokens.create({ id, role: 'reader', prefix: 'bench', tokenHash: hash(secret) });
    server.register('GET', '/projects', async () => ({ status: 204 }));
    const address = await server.listen(0);
    const url = `http://127.0.0.1:${address.port}/projects`;
    const headers = { authorization: `Bearer afk_bench_${secret}` };
    assert.equal((await fetch(url, { headers })).status, 204);
    await repo.tokens.revoke(id, 1n);
    assert.equal((await fetch(url, { headers })).status, 401);
  } finally {
    await server.close();
    await client.end();
  }
});
