import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApiServer } from '../api/server.ts';
import { registerAllHandlers } from '../api/handlers/register-all.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo } from '../db/repo/index.ts';
import { connectBench, databaseBench, jsonb } from './database-bench.ts';

const benchPromise = databaseBench(import.meta.url);
const owner = randomUUID(), draft = randomUUID(), token = randomUUID(), secret = randomUUID();
const now = new Date('2030-01-01T00:00:00.000Z');
let admin: ReturnType<typeof connectBench>, connection: ReturnType<typeof connectBench>;
let api: ReturnType<typeof createApiServer>, base: string;

before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  admin = connectBench(bench.migratorUrl);
  connection = connectBench(bench.apiUrl);
  await admin`INSERT INTO owners (id, name, telegram_user_id) VALUES (${owner}, 'Owner', 42)`;
  await admin`INSERT INTO api_tokens (id, role, prefix, token_hash) VALUES (${token}, 'relay', 'relay', ${createHash('sha256').update(secret).digest('hex')})`;
  await admin`INSERT INTO registry_records (id, kind, authority, status, scope_type, category, problem, decision, reuse, source, created_by)
    VALUES (${draft}, 'decision', 'owner', 'draft', 'global', 'security', 'Fixture question', 'Fixture answer', 'once', 'owner_message', ${jsonb({ type: 'owner', id: owner })}::text::jsonb)`;
  const repo = createRepo(drizzle(connection));
  api = createApiServer({ tokens: repo.tokens, clock: () => now });
  registerAllHandlers(api, repo, { now: () => now });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
after(async () => { await api?.close(); await connection?.end(); await admin?.end(); });

test('a sensitive draft cannot be activated by one registered Telegram press', async () => {
  const headers = { authorization: `Bearer afk_relay_${secret}`, 'idempotency-key': randomUUID() };
  const registered = await fetch(`${base}/registry/drafts/${draft}/presses`, { method: 'POST', headers });
  assert.equal(registered.status, 201);
  const { press_id } = await registered.json() as { press_id: string };
  const response = await fetch(`${base}/registry/drafts/${draft}/confirm`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify({ press_id, telegram_user_id: 42 }) });
  assert.equal(response.status, 409);
  const challenge = await response.json() as { code: string; confirmation_id: string; nonce: string };
  assert.equal(challenge.code, 'confirmation_required');
  const rows = await admin`SELECT status FROM registry_records WHERE id = ${draft}`;
  assert.equal(rows[0]!.status, 'draft');
  const next = await fetch(`${base}/registry/drafts/${draft}/presses`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() } });
  assert.equal(next.status, 201);
  const second = await next.json() as { press_id: string };
  const confirm = () => fetch(`${base}/registry/drafts/${draft}/confirm`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID(), 'content-type': 'application/json', 'x-confirm': `${challenge.confirmation_id}.${challenge.nonce}` }, body: JSON.stringify({ press_id: second.press_id, telegram_user_id: 42 }) });
  assert.equal((await confirm()).status, 200);
  const replay = await confirm();
  assert.equal(replay.status, 409);
  assert.equal((await replay.json() as { code: string }).code, 'press_replayed');
  const [changed] = await admin`SELECT status, status_changed_by FROM registry_records WHERE id = ${draft}`;
  assert.equal(changed!.status, 'active');
  assert.equal(changed!.status_changed_by.id, owner);
  assert.equal(changed!.status_changed_by.pressId, second.press_id);
});
