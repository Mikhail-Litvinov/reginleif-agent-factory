import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
it("applies migrations through 0007 once and seeds the standing task", async () => {
 const db = await bench;
 const applied = await migrate({ url: db.migratorUrl });
 assert.deepEqual(applied.slice(0, 7).map(name => name.slice(0, 4)), ["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
 assert.deepEqual(await migrate({ url: db.migratorUrl }), []);
 const sql = connectBench(db.migratorUrl);
 try {
  const rows = await sql`SELECT p.id FROM projects p JOIN tasks t ON t.project_id = p.id WHERE p.name = '_factory' AND t.origin_type = 'standing' AND t.status = 'RUNNING'`;
  assert.equal(rows.length, 1);
 } finally { await sql.end(); }
});

it("keeps answers ordered and refuses grants without a grant answer", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const task = randomUUID(), request = randomUUID(), answer = randomUUID();
 try {
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id) VALUES (${request}, ${task}, ${task})`;
  await assert.rejects(sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 1, 'owner', 'refuse')`, /answer/i);
  await sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${answer}, ${request}, 1, 'code', 'call_owner')`;
  await assert.rejects(sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 2, 'chief_engineer', 'refuse')`, /answer/i);
  await assert.rejects(sql`INSERT INTO right_grants (id, request_id, answer_id, task_id) VALUES (${randomUUID()}, ${request}, ${answer}, ${task})`, /grant/i);
  await sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 2, 'owner', 'refuse')`;
  await assert.rejects(sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 3, 'owner', 'refuse')`, /answer/i);
  await assert.rejects(sql`UPDATE right_requests SET reason = 'changed' WHERE id = ${request}`, /immutable/i);
  await assert.rejects(sql`DELETE FROM right_answers WHERE id = ${answer}`, /immutable/i);
 } finally { await sql.end(); }
});

it("blocks new runs for a suspended agent and enforces one open suspension", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const agent = randomUUID(), task = randomUUID(), suspension = randomUUID();
 try {
  await sql`INSERT INTO agents (id) VALUES (${agent})`;
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO rights_suspensions (id, agent_id, event_key) VALUES (${suspension}, ${agent}, ${randomUUID()})`;
  await assert.rejects(sql`INSERT INTO rights_suspensions (id, agent_id, event_key) VALUES (${randomUUID()}, ${agent}, ${randomUUID()})`, /unique/i);
  await assert.rejects(sql`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${randomUUID()}, ${task}, ${agent}, 'implementer')`, /suspended/i);
 } finally { await sql.end(); }
});

it("ties role status to its regulation and allows a chief engineer decision", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const regulation = randomUUID(), role = randomUUID(), task = randomUUID(), request = randomUUID(), run = randomUUID();
 try {
  await sql`INSERT INTO regulation_versions (id, status) VALUES (${regulation}, 'draft')`;
  await sql`INSERT INTO roles (id, name, version, status, regulation_version_id, rights) VALUES (${role}, ${randomUUID()}, 1, 'draft', ${regulation}, '[]'::jsonb)`;
  await assert.rejects(sql`UPDATE roles SET status = 'active' WHERE id = ${role}`, /regulation/i);
  await assert.rejects(sql`UPDATE roles SET rights = '["text"]'::jsonb WHERE id = ${role}`, /immutable|rights/i);
  await sql`UPDATE regulation_versions SET status = 'active' WHERE id = ${regulation}`;
  assert.equal((await sql`SELECT status FROM roles WHERE id = ${role}`)[0]?.status, 'active');
  assert.equal((await sql`SELECT id FROM audit_log WHERE action = 'role.status' AND target_id = ${role}`).length, 1);
  await sql`INSERT INTO tasks (id, depth, status, block_kind, block_handler) VALUES (${task}, 0, 'BLOCKED', 'execution', 'chief_engineer')`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id) VALUES (${request}, ${task}, ${task})`;
  await sql`INSERT INTO task_runs (id, task_id, role) VALUES (${run}, ${task}, 'chief_engineer')`;
  const decision = randomUUID();
  await sql.begin(async tx => {
   await tx`INSERT INTO outbox_events (id, decision_id) VALUES (${request}, ${decision})`;
   await tx`INSERT INTO task_decisions (id, task_id, engineer_run_id, kind, channel, revision_number, outbox_id) VALUES (${decision}, ${task}, ${run}, 'resolve_block', 'api', 1, ${request})`;
  });
 } finally { await sql.end(); }
});

it("refuses self-restoration and permits a separate chief engineer", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const subject = randomUUID(), chief = randomUUID(), task = randomUUID(), request = randomUUID(), ownRun = randomUUID(), chiefRun = randomUUID(), suspension = randomUUID();
 try {
  await sql`INSERT INTO agents (id) VALUES (${subject}), (${chief})`;
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id) VALUES (${request}, ${task}, ${task})`;
  await sql`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${ownRun}, ${task}, ${subject}, 'implementer'), (${chiefRun}, ${task}, ${chief}, 'chief_engineer')`;
  await sql`INSERT INTO rights_suspensions (id, agent_id, event_key) VALUES (${suspension}, ${subject}, ${randomUUID()})`;
  await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${JSON.stringify({ type: 'run', id: ownRun })}::jsonb WHERE id = ${suspension}`, /actor/i);
  await sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${JSON.stringify({ type: 'run', id: chiefRun })}::jsonb WHERE id = ${suspension}`;
  await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = NULL WHERE id = ${suspension}`, /twice/i);
 } finally { await sql.end(); }
});

it("requires an owner to restore a suspended chief engineer", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const agent = randomUUID(), owner = randomUUID(), task = randomUUID(), request = randomUUID(), run = randomUUID(), suspension = randomUUID();
 try {
  await sql`INSERT INTO agents (id) VALUES (${agent})`;
  await sql`INSERT INTO owners (id) VALUES (${owner})`;
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id) VALUES (${request}, ${task}, ${task})`;
  await sql`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${run}, ${task}, ${agent}, 'chief_engineer')`;
  await sql`INSERT INTO rights_suspensions (id, agent_id, run_id, event_key) VALUES (${suspension}, ${agent}, ${run}, ${randomUUID()})`;
  await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${JSON.stringify({ type: 'run', id: run })}::jsonb WHERE id = ${suspension}`, /actor/i);
  await sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${JSON.stringify({ type: 'owner', id: owner })}::jsonb WHERE id = ${suspension}`;
 } finally { await sql.end(); }
});

it("creates an owner grant only with a matching unused confirmation", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const owner = randomUUID(), task = randomUUID(), request = randomUUID(), confirmation = randomUUID(), answer = randomUUID();
 try {
  await sql`INSERT INTO owners (id) VALUES (${owner})`;
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id, participant, action, target, conditions, request_hash) VALUES (${request}, ${task}, ${task}, 'participant', 'read', 'example', '{}'::jsonb, 'hash')`;
  await sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 1, 'code', 'call_owner')`;
  await assert.rejects(sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer, owner_act_ref) VALUES (${randomUUID()}, ${request}, 2, 'owner', 'grant', ${randomUUID()})`, /confirmation/i);
  await sql`INSERT INTO confirmations (id, actor_id, target_id, request_hash, expires_at) VALUES (${confirmation}, ${owner}, ${request}, 'hash', now() + interval '1 hour')`;
  await sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer, owner_act_ref) VALUES (${answer}, ${request}, 2, 'owner', 'grant', ${confirmation})`;
  const grants = await sql`SELECT clause_id, granted_by_run_id FROM right_grants WHERE answer_id = ${answer}`;
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.clause_id, null);
  assert.equal(grants[0]?.granted_by_run_id, null);
  assert.ok((await sql`SELECT used_at FROM confirmations WHERE id = ${confirmation}`)[0]?.used_at);
 } finally { await sql.end(); }
});

it("validates permissions and stores a run profile once", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const record = randomUUID(), task = randomUUID(), run = randomUUID();
 try {
  await assert.rejects(sql`INSERT INTO registry_records (id, kind, authority, source, status) VALUES (${randomUUID()}, 'permission', 'owner', 'owner_button', 'draft')`, /right/i);
  await assert.rejects(sql`INSERT INTO registry_records (id, kind, authority, source, status, right) VALUES (${randomUUID()}, 'permission', 'agent', 'owner_button', 'draft', '{"action":"read","target":"example","conditions":{}}'::jsonb)`, /permission|check/i);
  await sql`INSERT INTO registry_records (id, kind, authority, source, status, reuse, right) VALUES (${record}, 'permission', 'owner', 'owner_button', 'draft', 'once', '{"action":"read","target":"example","conditions":{}}'::jsonb)`;
  await sql`UPDATE registry_records SET consumed_at = now() WHERE id = ${record}`;
  await assert.rejects(sql`UPDATE registry_records SET consumed_at = NULL WHERE id = ${record}`, /once/i);
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO task_runs (id, task_id, role, profile_rights) VALUES (${run}, ${task}, 'implementer', ${JSON.stringify([{ source: record }])}::jsonb)`;
  await assert.rejects(sql`UPDATE task_runs SET profile_rights = '[]'::jsonb WHERE id = ${run}`, /immutable/i);
 } finally { await sql.end(); }
});

it("refuses a grant to a suspended requester without spending the owner's act", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl);
 const agent = randomUUID(), owner = randomUUID(), task = randomUUID(), run = randomUUID(), request = randomUUID(), confirmation = randomUUID();
 try {
  await sql`INSERT INTO agents (id) VALUES (${agent})`;
  await sql`INSERT INTO owners (id) VALUES (${owner})`;
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${run}, ${task}, ${agent}, 'implementer')`;
  await sql`INSERT INTO right_requests (id, task_id, handling_task_id, run_id, participant, action, target, conditions, request_hash) VALUES (${request}, ${task}, ${task}, ${run}, 'participant', 'read', 'example', '{}'::jsonb, 'hash')`;
  await sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 1, 'code', 'call_owner')`;
  await sql`INSERT INTO confirmations (id, actor_id, target_id, request_hash, expires_at) VALUES (${confirmation}, ${owner}, ${request}, 'hash', now() + interval '1 hour')`;
  await sql`INSERT INTO rights_suspensions (id, agent_id, event_key) VALUES (${randomUUID()}, ${agent}, ${randomUUID()})`;
  await assert.rejects(sql`INSERT INTO right_answers (id, request_id, step, step_kind, answer, owner_act_ref) VALUES (${randomUUID()}, ${request}, 2, 'owner', 'grant', ${confirmation})`, /suspended/i);
  assert.equal((await sql`SELECT used_at FROM confirmations WHERE id = ${confirmation}`)[0]?.used_at, null);
  assert.equal((await sql`SELECT id FROM right_grants WHERE request_id = ${request}`).length, 0);
 } finally { await sql.end(); }
});

it("restricts rights table writes for application and backup roles", async () => {
 const db = await bench;
 for (const [role, url] of [["api", db.apiUrl], ["control", db.controlUrl], ["backup", db.backupUrl]] as const) {
  const sql = connectBench(url);
  try {
   for (const table of ["roles", "role_assignments", "right_requests", "right_answers", "right_grants", "rights_suspensions"]) {
    await sql.unsafe(`SELECT * FROM ${table} LIMIT 0`);
    await assert.rejects(sql.unsafe(`DELETE FROM ${table}`), /permission denied/i);
    if (role === "backup") await assert.rejects(sql.unsafe(`INSERT INTO ${table} (id) VALUES ($1)`, [randomUUID()]), /permission denied/i);
   }
   if (role !== "backup") await assert.rejects(sql`UPDATE right_requests SET reason = 'changed' WHERE false`, /permission denied/i);
   if (role !== "backup") {
    await sql`INSERT INTO right_requests (id, session_ref) VALUES (${randomUUID()}, 'session')`;
    await sql`UPDATE role_assignments SET superseded_at = now() WHERE false`;
    await sql`UPDATE right_grants SET ended_at = now() WHERE false`;
    await sql`UPDATE rights_suspensions SET ended_at = now() WHERE false`;
    await assert.rejects(sql`UPDATE right_answers SET reason = 'changed' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE roles SET rights = '[]'::jsonb WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE role_assignments SET participant = 'changed' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE right_grants SET right = '{}'::jsonb WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE rights_suspensions SET reason = 'changed' WHERE false`, /permission denied/i);
   }
  } finally { await sql.end(); }
 }
});
