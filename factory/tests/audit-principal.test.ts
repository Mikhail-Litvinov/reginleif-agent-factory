import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { writeAudit } from '../api/handlers/shared.ts';
import type { HandlerContext } from '../api/server.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo, type Repo } from '../db/repo/index.ts';
import { connectBench, databaseBench, type DatabaseBench } from './database-bench.ts';

// database.md: device_session_id is set on every row a device session caused; token_id names a token and only a token.
const benchPromise = databaseBench(import.meta.url);
const ownerId = randomUUID();
const deviceId = randomUUID();
const sessionId = randomUUID();
const tokenId = randomUUID();
let bench: DatabaseBench;
let admin: ReturnType<typeof connectBench>;
let database: ReturnType<typeof connectBench>;
let repo: Repo;

before(async () => {
  bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  admin = connectBench(bench.migratorUrl);
  database = connectBench(bench.apiUrl);
  repo = createRepo(drizzle(database));
  await admin`INSERT INTO owners (id, name) VALUES (${ownerId}, 'Audit owner')`;
  await repo.devices.create({ id: deviceId, ownerId, name: 'Phone', platform: 'android', codeHash: 'x'.repeat(64), codeExpiresAt: new Date(Date.now() + 60_000) });
  await repo.deviceSessions.create({ id: sessionId, deviceId, prefix: 'p', tokenHash: createHash('sha256').update('s').digest('hex'), expiresAt: new Date(Date.now() + 60_000) });
});

after(async () => {
  await database?.end();
  await admin?.end();
});

const contextOf = (identity: HandlerContext['identity'], requestId: string) => ({
  identity, requestId, request: { method: 'POST', url: '/x' }, route: { path: '/x' },
}) as unknown as HandlerContext;

const rowOf = async (requestId: string) => (await admin<{ token_id: string | null; device_session_id: string | null }[]>`SELECT token_id, device_session_id FROM audit_log WHERE request_id = ${requestId}`)[0]!;

test('an audit row caused by a device session names the session and no token', async () => {
  const requestId = randomUUID();
  await writeAudit(repo, contextOf({ id: sessionId, ownerId, role: 'device' } as HandlerContext['identity'], requestId), 'x.do', 'x', null, 'ok', {});
  assert.deepEqual(await rowOf(requestId), { token_id: null, device_session_id: sessionId });
});

test('an audit row caused by a token names the token and no device session', async () => {
  const requestId = randomUUID();
  await writeAudit(repo, contextOf({ id: tokenId, ownerId, role: 'owner' } as HandlerContext['identity'], requestId), 'x.do', 'x', null, 'ok', {});
  assert.deepEqual(await rowOf(requestId), { token_id: tokenId, device_session_id: null });
});
