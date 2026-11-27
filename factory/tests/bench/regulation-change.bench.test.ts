import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createApiServer } from '../../api/server.ts';
import { registerRegistryHandlers } from '../../api/handlers/registry.ts';
import { migrate } from '../../db/migrate.ts';
import { createRepo } from '../../db/repo/index.ts';
import { connectBench, databaseBench } from '../database-bench.ts';

const bench = databaseBench(import.meta.url);
const ownerId = randomUUID();
const ownerSecret = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = new Date('2030-02-03T04:05:06.000Z');
let sql: ReturnType<typeof postgres>;
let apiSql: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
let server: ReturnType<typeof createApiServer>;
let base = '';

before(async () => {
  const db = await bench;
  await migrate({ url: db.migratorUrl });
  sql = connectBench(db.migratorUrl);
  apiSql = connectBench(db.apiUrl);
  repo = createRepo(drizzle(apiSql));
  await sql`INSERT INTO owners (id) VALUES (${ownerId})`;
  await sql`INSERT INTO settings (key, value) VALUES ('registry.enabled', 'true'::jsonb), ('confirm.windowSeconds', '60'::jsonb), ('registry.clauseMaxBytes', '4096'::jsonb), ('page.defaultLimit', '50'::jsonb), ('page.maxLimit', '100'::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  await repo.tokens.create({ id: ownerId, role: 'owner', ownerId, prefix: 'registry-owner', tokenHash: hash(ownerSecret) });
  server = createApiServer({ tokens: repo.tokens });
  registerRegistryHandlers(server, repo, { now: () => now });
  const address = await server.listen(0);
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await server?.close(); await Promise.all([sql?.end(), apiSql?.end()]); });

test('regulation-change: API requires the second press and activates only with its issued confirmation', async () => {
  const headers = { authorization: `Bearer afk_registry-owner_${ownerSecret}`, 'content-type': 'application/json' };
  const created = await fetch(`${base}/regulation/versions`, { method: 'POST', headers, body: JSON.stringify({ clauses: [] }) });
  assert.equal(created.status, 201);
  const version = await created.json() as { id: string; status: string };
  assert.equal(version.status, 'draft');

  const activateUrl = `${base}/regulation/versions/${version.id}/activate`;
  const first = await fetch(activateUrl, { method: 'POST', headers });
  assert.equal(first.status, 409);
  const required = await first.json() as { code: string; confirmation_id: string; nonce: string; expires_at: string };
  assert.equal(required.code, 'confirmation_required');
  assert.ok(required.expires_at);
  assert.equal((await repo.registry.regulations.get(version.id))?.status, 'draft');

  const second = await fetch(activateUrl, { method: 'POST', headers: { ...headers, 'x-confirm': `${required.confirmation_id}.${required.nonce}` } });
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { status: string }).status, 'active');
  assert.equal((await repo.registry.regulations.get(version.id))?.confirmedBy, ownerId);
  assert.equal((await repo.confirmations.get(required.confirmation_id))?.usedAt?.toISOString(), now.toISOString());
});
