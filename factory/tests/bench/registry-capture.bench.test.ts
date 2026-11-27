import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createApiServer } from '../../api/server.ts';
import { registerRegistryHandlers } from '../../api/handlers/registry.ts';
import { migrate } from '../../db/migrate.ts';
import { createRepo } from '../../db/repo/index.ts';
import { createRegistryService } from '../../registry/service.ts';
import { connectBench, databaseBench } from '../database-bench.ts';

const bench = databaseBench(import.meta.url);
const ownerId = randomUUID();
const relayId = randomUUID();
const relaySecret = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = new Date('2030-01-01T00:00:00.000Z');
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
  await sql`INSERT INTO owners (id, telegram_user_id) VALUES (${ownerId}, '7311001')`;
  await sql`INSERT INTO settings (key, value) VALUES ('registry.enabled', 'true'::jsonb), ('page.defaultLimit', '50'::jsonb), ('page.maxLimit', '100'::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  await repo.tokens.create({ id: relayId, role: 'relay', prefix: 'registry-relay', tokenHash: hash(relaySecret) });
  server = createApiServer({ tokens: repo.tokens });
  registerRegistryHandlers(server, repo, { now: () => now });
  const address = await server.listen(0);
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await server?.close(); await Promise.all([sql?.end(), apiSql?.end()]); });

test('registry-capture: relay press creates one immutable record and replay is refused', async () => {
  const service = createRegistryService(repo);
  const { inquiry } = await service.openInquiry({ type: 'owner', id: ownerId }, {
    id: randomUUID(), problem: 'Tabs or spaces?', category: 'formatting', projectId: null, reuseIntent: 'once',
  }, []);
  const question = 'Choose indentation';
  const options = [{ key: 'tabs', label: 'Use tabs' }, { key: 'spaces', label: 'Use spaces' }];
  const registered = await fetch(`${base}/registry/polls`, {
    method: 'POST', headers: { authorization: `Bearer afk_registry-relay_${relaySecret}`, 'content-type': 'application/json', 'idempotency-key': 'poll-key-1' },
    body: JSON.stringify({ inquiry_id: inquiry.id, question, options }),
  });
  assert.equal(registered.status, 201);
  const pressId = randomUUID();
  // The relay routes are idempotent: each delivery carries its own key, so a second delivery of the same press is a new request that the press rule refuses.
  const capture = (key: string) => fetch(`${base}/registry/captures`, {
    method: 'POST', headers: { authorization: `Bearer afk_registry-relay_${relaySecret}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ press_id: pressId, telegram_user_id: 7311001, poll_id: inquiry.id, option_index: 1 }),
  });
  const first = await capture('capture-key-1');
  assert.equal(first.status, 200);
  const row = await first.json() as { id: string; problem: string; question: string; options: unknown; decision: string; pressed_option: string; source: string; press_id: string };
  assert.equal(row.problem, question);
  assert.equal(row.question, question);
  assert.deepEqual(row.options, options);
  assert.equal(row.decision, 'Use spaces');
  assert.equal(row.pressed_option, row.decision);
  assert.equal(row.source, 'poll_press');
  assert.equal(row.press_id, pressId);
  const replay = await capture('capture-key-2');
  assert.equal(replay.status, 409);
  assert.equal((await replay.json() as { code: string }).code, 'press_replayed');
  assert.equal((await repo.registry.records.get(row.id))?.pressId, pressId);
});
