import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
it("applies migrations 0001 through 0006 in order", async () => {
 const db = await bench;
 const applied = await migrate({ url: db.migratorUrl });
 assert.deepEqual(applied.slice(0, 6).map(name => name.slice(0, 4)), ["0001", "0002", "0003", "0004", "0005", "0006"]);
});

it("checks vector size, search indexes, audit and immutability", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const record = randomUUID(), regulation = randomUUID(), inquiry = randomUUID(), result = randomUUID();
 try {
  await sql`INSERT INTO registry_records (id, status) VALUES (${record}, 'draft')`;
  await sql`INSERT INTO regulation_versions (id, status) VALUES (${regulation}, 'draft')`;
  await sql`INSERT INTO registry_inquiries (id) VALUES (${inquiry})`;
  await sql`INSERT INTO registry_inquiry_results (id, inquiry_id, record_id) VALUES (${result}, ${inquiry}, ${record})`;
  const vec = `[${Array(1024).fill(0).join(",")}]`;
  await sql`INSERT INTO registry_embeddings (id, record_id, embedding) VALUES (${randomUUID()}, ${record}, ${vec}::vector)`;
  await assert.rejects(sql`INSERT INTO registry_embeddings (id, embedding) VALUES (${randomUUID()}, '[0,0]'::vector)`, /dimension/i);
  const indexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('registry_records_search_ru','registry_records_search_en','registry_records_problem_trgm','registry_records_decision_trgm','registry_embeddings_cosine','registry_records_filters')`;
  assert.equal(indexes.length, 6);
  for (const name of ['registry_records_problem_trgm', 'registry_records_decision_trgm']) assert.match(indexes.find(row => row.indexname === name)?.indexdef ?? '', /USING gin .*gin_trgm_ops/i);
  assert.match(indexes.find(row => row.indexname === 'registry_embeddings_cosine')?.indexdef ?? '', /USING hnsw .*vector_cosine_ops/i);
  for (const name of ['registry_records_search_ru', 'registry_records_search_en']) assert.match(indexes.find(row => row.indexname === name)?.indexdef ?? '', /USING gin/i);
  await sql`UPDATE registry_records SET status = 'rejected' WHERE id = ${record}`;
  await sql`UPDATE regulation_versions SET status = 'revoked' WHERE id = ${regulation}`;
  assert.equal((await sql`SELECT id FROM audit_log WHERE target_id IN (${record},${regulation}) AND action IN ('registry.status','regulation.status')`).length, 2);
  await assert.rejects(sql`UPDATE registry_records SET problem = 'changed' WHERE id = ${record}`, /immutable/i);
  await assert.rejects(sql`DELETE FROM registry_embeddings WHERE record_id = ${record}`, /immutable/i);
  await sql`UPDATE registry_inquiries SET poll_question = 'question' WHERE id = ${inquiry}`;
  await assert.rejects(sql`UPDATE registry_inquiries SET poll_question = 'changed' WHERE id = ${inquiry}`, /immutable|once/i);
  await sql`UPDATE registry_inquiry_results SET verdict = 'applies' WHERE id = ${result}`;
  await assert.rejects(sql`UPDATE registry_inquiry_results SET verdict = 'outdated', difference = 'changed' WHERE id = ${result}`, /immutable|once/i);
 } finally { await sql.end(); }
});

it("activates, replaces and revokes regulation rules atomically", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const first = randomUUID(), second = randomUUID(), v1 = randomUUID(), v2 = randomUUID(), invalid = randomUUID();
 try {
  await sql`INSERT INTO registry_records (id, kind, status, scope_type) VALUES (${first}, 'rule', 'draft', 'global'), (${second}, 'rule', 'draft', 'global')`;
  await sql`INSERT INTO regulation_versions (id, status, clauses, clauses_bytes) VALUES (${v1}, 'draft', ${JSON.stringify([first])}::jsonb, 2), (${v2}, 'draft', ${JSON.stringify([{ record_id: second }])}::jsonb, 2), (${invalid}, 'draft', ${JSON.stringify([randomUUID()])}::jsonb, 2)`;
  await sql`INSERT INTO settings (key, value) VALUES ('registry.clauseMaxBytes', '1'::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  await assert.rejects(sql`UPDATE regulation_versions SET status = 'active' WHERE id = ${v1}`, /clauseMaxBytes/i);
  await sql`UPDATE settings SET value = '2'::jsonb WHERE key = 'registry.clauseMaxBytes'`;
  await assert.rejects(sql`UPDATE registry_records SET status = 'active' WHERE id = ${first}`, /regulation/i);
  await assert.rejects(sql`UPDATE regulation_versions SET status = 'active' WHERE id = ${invalid}`, /clause/i);
  await sql`UPDATE regulation_versions SET status = 'active' WHERE id = ${v1}`;
  assert.equal((await sql`SELECT status FROM registry_records WHERE id = ${first}`)[0]?.status, 'active');
  await sql`UPDATE regulation_versions SET status = 'active' WHERE id = ${v2}`;
  assert.equal((await sql`SELECT status FROM registry_records WHERE id = ${first}`)[0]?.status, 'superseded');
  assert.equal((await sql`SELECT status FROM regulation_versions WHERE id = ${v1}`)[0]?.status, 'superseded');
  await sql`UPDATE regulation_versions SET status = 'revoked' WHERE id = ${v2}`;
  assert.equal((await sql`SELECT status FROM registry_records WHERE id = ${second}`)[0]?.status, 'revoked');
  assert.equal((await sql`SELECT id FROM audit_log WHERE target_id IN (${first},${second}) AND action = 'registry.status'`).length, 4);
 } finally { await sql.end(); }
});

it("enforces database grants and registry token binding", async () => {
 const db = await bench;
 for (const [role, url] of [["api", db.apiUrl], ["control", db.controlUrl], ["backup", db.backupUrl]] as const) {
  const sql = connectBench(url);
  try {
   for (const table of ["regulation_versions", "registry_inquiries", "registry_records", "registry_links", "registry_embeddings", "registry_inquiry_results"]) {
    await sql.unsafe(`SELECT * FROM ${table} LIMIT 0`);
    await assert.rejects(sql.unsafe(`DELETE FROM ${table}`), /permission denied/i);
    if (role === "backup") await assert.rejects(sql.unsafe(`INSERT INTO ${table} (id) VALUES ($1)`, [randomUUID()]), /permission denied/i);
    else if (table === "registry_records") await sql`INSERT INTO registry_records (id, status, source) VALUES (${randomUUID()}, 'draft', 'agent_proposal')`;
    else await sql.unsafe(`INSERT INTO ${table} (id) VALUES ($1)`, [randomUUID()]);
   }
   if (role === "backup") await assert.rejects(sql`INSERT INTO registry_inquiries (id) VALUES (${randomUUID()})`, /permission denied/i);
   else {
    await sql`INSERT INTO registry_inquiries (id) VALUES (${randomUUID()})`;
    await sql`UPDATE registry_inquiries SET poll_question = 'x' WHERE false`;
    await assert.rejects(sql`UPDATE registry_inquiries SET problem = 'x' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE registry_links SET link_type = 'evidence' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE registry_embeddings SET dimensions = 1024 WHERE false`, /permission denied/i);
    if (role === "control") await assert.rejects(sql`INSERT INTO registry_records (id, status, source) VALUES (${randomUUID()}, 'draft', 'owner_message')`, /control/i);
   }
  } finally { await sql.end(); }
 }
 const sql = connectBench(db.migratorUrl);
 try {
  await assert.rejects(sql`INSERT INTO api_tokens (id, role) VALUES (${randomUUID()}, 'registry')`, /registry_binding/i);
  await sql`INSERT INTO api_tokens (id, role, session_ref) VALUES (${randomUUID()}, 'registry', 'session')`;
 } finally { await sql.end(); }
});
