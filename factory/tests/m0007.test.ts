import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import type { TransactionSql } from "postgres";
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
  await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${sql.json({ type: 'run', id: ownRun })} WHERE id = ${suspension}`, /actor/i);
  await sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${sql.json({ type: 'run', id: chiefRun })} WHERE id = ${suspension}`;
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
  await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${sql.json({ type: 'run', id: run })} WHERE id = ${suspension}`, /actor/i);
  await sql`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${sql.json({ type: 'owner', id: owner })} WHERE id = ${suspension}`;
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
  await assert.rejects(sql`INSERT INTO registry_records (id, kind, authority, source, status, "right") VALUES (${randomUUID()}, 'permission', 'agent', 'owner_button', 'draft', '{"action":"read","target":"example","conditions":{}}'::jsonb)`, /permission|check/i);
  await sql`INSERT INTO registry_records (id, kind, authority, source, status, reuse, "right") VALUES (${record}, 'permission', 'owner', 'owner_button', 'draft', 'once', '{"action":"read","target":"example","conditions":{}}'::jsonb)`;
  await sql`UPDATE registry_records SET consumed_at = now() WHERE id = ${record}`;
  await assert.rejects(sql`UPDATE registry_records SET consumed_at = NULL WHERE id = ${record}`, /once/i);
  await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
  await sql`INSERT INTO task_runs (id, task_id, role, profile_rights) VALUES (${run}, ${task}, 'implementer', ${sql.json([{ source: record }])})`;
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
   // database.md lines 544-551: af_control inserts requests, answers, grants and suspensions only, and updates only the
   // ending columns of grants; af_api additionally inserts roles and assignments and updates their status columns.
   if (role === "control") {
    for (const table of ["roles", "role_assignments"]) await assert.rejects(sql.unsafe(`INSERT INTO ${table} (id) VALUES ($1)`, [randomUUID()]), /permission denied/i);
    await assert.rejects(sql`UPDATE role_assignments SET superseded_at = now() WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE rights_suspensions SET ended_at = now() WHERE false`, /permission denied/i);
   }
   if (role !== "backup") {
    await sql`INSERT INTO right_requests (id, session_ref) VALUES (${randomUUID()}, 'session')`;
    if (role === "api") {
     await sql`UPDATE role_assignments SET superseded_at = now() WHERE false`;
     await sql`UPDATE rights_suspensions SET ended_at = now() WHERE false`;
    }
    await sql`UPDATE right_grants SET ended_at = now() WHERE false`;
    await assert.rejects(sql`UPDATE right_answers SET reason = 'changed' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE roles SET rights = '[]'::jsonb WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE role_assignments SET participant = 'changed' WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE right_grants SET "right" = '{}'::jsonb WHERE false`, /permission denied/i);
    await assert.rejects(sql`UPDATE rights_suspensions SET reason = 'changed' WHERE false`, /permission denied/i);
   }
  } finally { await sql.end(); }
 }
});

type RunFixture = {
 sources: string[] | null;
 assignment?: string;
 agent?: string;
 status?: string;
 participant?: string;
 attempt?: number;
 withoutExecution?: boolean;
 confirmedEnd?: boolean;
};

const participant = "implementer";

async function addRuns(tx: TransactionSql, task: string, fixtures: RunFixture[]) {
 const rows = fixtures.map((fixture) => ({
  id: randomUUID(), execution_id: fixture.withoutExecution ? null : randomUUID(),
  status: fixture.status ?? "running", confirmed_end: fixture.confirmedEnd ?? false,
  participant: fixture.participant ?? participant, attempt_number: fixture.attempt ?? null,
  agent_id: fixture.agent ?? null, role_assignment_id: fixture.assignment ?? null,
  profile_rights: fixture.sources?.map((source) => ({ source })) ?? null,
 }));
 await tx`INSERT INTO task_runs (id, task_id, participant, attempt_number, role, execution_id, status, finished_at, agent_id, role_assignment_id, profile_rights)
  SELECT id, ${task}, participant, attempt_number, 'implementer', execution_id, status, CASE WHEN confirmed_end THEN now() END, agent_id, role_assignment_id, profile_rights
  FROM jsonb_to_recordset(${tx.json(rows)}) AS run(id uuid, execution_id uuid, status text, confirmed_end boolean,
   participant text, attempt_number integer, agent_id uuid, role_assignment_id uuid, profile_rights jsonb)`;
 return rows.map(({ id, execution_id }) => ({ task_id: task, run_id: id, execution_id }));
}

async function assertStops(tx: TransactionSql, tasks: string[], expected: Awaited<ReturnType<typeof addRuns>>) {
 const orders = await tx`SELECT task_id, payload->>'run_id' AS run_id, payload->>'execution_id' AS execution_id, state
  FROM outbox_events WHERE kind = 'stop_run' AND task_id IN ${tx(tasks)} ORDER BY payload->>'run_id'`;
 assert.deepEqual([...orders], expected.map((run) => ({ ...run, state: "pending" })).sort((a, b) => a.run_id.localeCompare(b.run_id)));
}

async function addGrant(tx: TransactionSql, task: string, run: string | null, session: string | null = null) {
 const request = randomUUID(), owner = randomUUID(), confirmation = randomUUID(), answer = randomUUID();
 await tx`INSERT INTO owners (id) VALUES (${owner})`;
 await tx`INSERT INTO right_requests (id, task_id, handling_task_id, session_ref, run_id, participant, action, target, conditions, request_hash)
  VALUES (${request}, ${session === null ? task : null}, CASE WHEN ${session}::text IS NULL THEN ${task}::uuid ELSE (
   SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.name = '_factory' AND t.origin_type = 'standing'
  ) END, ${session}, ${run}, ${participant}, 'read', 'example', '{}'::jsonb, ${request})`;
 await tx`INSERT INTO right_answers (id, request_id, step, step_kind, answer) VALUES (${randomUUID()}, ${request}, 1, 'code', 'call_owner')`;
 await tx`INSERT INTO confirmations (id, actor_id, target_id, request_hash, expires_at)
  VALUES (${confirmation}, ${owner}, ${request}, ${request}, 'infinity'::timestamptz)`;
 await tx`INSERT INTO right_answers (id, request_id, step, step_kind, answer, owner_act_ref)
  VALUES (${answer}, ${request}, 2, 'owner', 'grant', ${confirmation})`;
 const [grant] = await tx<{ id: string }[]>`SELECT id FROM right_grants WHERE answer_id = ${answer}`;
 assert.ok(grant);
 return grant.id;
}

for (const ending of ["revocation", "task_end", "session_end"] as const) {
 it(`grant-ends: ${ending} stops all live snapshots holding the ended grant`, async () => {
  // One transaction needs owner answers (af_api) and code answers (af_control), database.md 548-549; the trigger checks session_user, so the migrator runs the lifecycle.
  const db = await bench, sql = connectBench(db.migratorUrl);
  const task = randomUUID(), otherTask = randomUUID(), requester = randomUUID(), session = randomUUID();
  try {
   await sql.begin(async (tx) => {
    await tx`INSERT INTO tasks (id, status) VALUES (${task}, 'CREATED'), (${otherTask}, 'CREATED')`;
    await tx`INSERT INTO task_runs (id, task_id, role, participant, attempt_number, execution_id, status)
     VALUES (${requester}, ${task}, 'implementer', ${participant}, 1, ${randomUUID()}, 'running')`;
    const sessionEnd = ending === "session_end";
    const grant = await addGrant(tx, task, sessionEnd ? null : requester, sessionEnd ? session : null);
    // The next attempt of the participant can still hold the grant after the first attempt finishes.
    // The API role cannot update runs, so exercise this lifecycle through the control connection.
    if (ending === "task_end") {
     await tx`UPDATE task_runs SET status = 'finished', finished_at = now() WHERE id = ${requester}`;
     const [open] = await tx`SELECT ended_at FROM right_grants WHERE id = ${grant}`;
     assert.equal(open?.ended_at, null);
    }
    const otherGrant = await addGrant(tx, otherTask, null, sessionEnd ? randomUUID() : null);
    const secondTaskGrant = ending === "task_end" ? await addGrant(tx, task, requester) : null;
    const sources = secondTaskGrant === null ? [grant] : [grant, secondTaskGrant];
    const matches = await addRuns(tx, task, [{ sources, attempt: 2 }, { sources, status: "cancelling" }]);
    const crossTask = await addRuns(tx, otherTask, [{ sources, status: "unclear" }]);
    await addRuns(tx, task, [
     { sources, status: "finished" }, { sources, confirmedEnd: true }, { sources, withoutExecution: true },
     { sources: [otherGrant] }, { sources: null },
    ]);
    if (ending === "task_end") {
     await tx`UPDATE tasks SET status = 'PLANNING' WHERE id = ${task}`;
     await assertStops(tx, [task, otherTask], []);
     await tx`UPDATE tasks SET status = 'CANCELLED' WHERE id = ${task}`;
     await assert.rejects(tx.savepoint((nested) => addGrant(nested, task, requester)), /grant task has ended/);
     assert.equal((await tx`SELECT ended_by FROM right_grants WHERE id = ${secondTaskGrant}`)[0]?.ended_by, "task_end");
    } else if (ending === "session_end") {
     await tx`UPDATE right_grants SET ended_at = now(), ended_by = 'session_end' WHERE session_ref = ${session} AND ended_at IS NULL`;
    } else {
     await tx`UPDATE right_grants SET ended_at = now(), ended_by = 'revocation' WHERE id = ${grant}`;
    }
    const [closed] = await tx`SELECT ended_at, ended_by FROM right_grants WHERE id = ${grant}`;
    const [other] = await tx`SELECT ended_by FROM right_grants WHERE id = ${otherGrant}`;
    assert.ok(closed?.ended_at);
    assert.equal(closed.ended_by, ending);
    assert.equal(other?.ended_by, null);
    await assertStops(tx, [task, otherTask], [...matches, ...crossTask]);
   });
  } finally { await sql.end(); }
 });
}

it("rights-snapshot: permission revocation and its stop orders roll back together", async () => {
 const db = await bench, sql = connectBench(db.apiUrl);
 const task = randomUUID(), record = randomUUID(), unrelated = randomUUID();
 try {
  await sql.begin(async (tx) => {
   await tx`INSERT INTO tasks (id) VALUES (${task})`;
   await tx`INSERT INTO registry_records (id, kind, authority, source, status, "right") VALUES
    (${record}, 'permission', 'owner', 'owner_button', 'draft', '{"action":"read","target":"example","conditions":{}}'::jsonb),
    (${unrelated}, 'permission', 'owner', 'owner_button', 'draft', '{"action":"read","target":"example","conditions":{}}'::jsonb)`;
   await tx`UPDATE registry_records SET status = 'active' WHERE id IN (${record}, ${unrelated})`;
   const matches = await addRuns(tx, task, [{ sources: [record] }, { sources: [unrelated, record] }]);
   await addRuns(tx, task, [{ sources: [unrelated] }, { sources: [record], status: "cancelled" }, { sources: null }]);
   await assert.rejects(tx.savepoint(async (nested) => {
    await nested`UPDATE registry_records SET status = 'revoked' WHERE id = ${record}`;
    await assertStops(nested, [task], matches);
    throw new Error("roll back revocation");
   }), /roll back revocation/);
   assert.equal((await tx`SELECT status FROM registry_records WHERE id = ${record}`)[0]?.status, "active");
   await assertStops(tx, [task], []);
   await tx`UPDATE registry_records SET status = 'revoked' WHERE id = ${record}`;
   await assertStops(tx, [task], matches);
  });
 } finally { await sql.end(); }
});

it("rights-snapshot: regulation replacement stops snapshots of the old role version", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl); // af_control does not insert regulation_versions or roles (database.md 535-543)
 const oldVersion = randomUUID(), replacement = randomUUID(), oldRole = randomUUID(), newRole = randomUUID();
 const task = randomUUID(), oldAssignment = randomUUID(), newAssignment = randomUUID();
 try {
  await sql.begin(async (tx) => {
   await tx`INSERT INTO tasks (id) VALUES (${task})`;
   await tx`INSERT INTO regulation_versions (id, status) VALUES (${oldVersion}, 'draft'), (${replacement}, 'draft')`;
   await tx`INSERT INTO roles (id, name, version, status, regulation_version_id, rights) VALUES
    (${oldRole}, ${oldRole}, 1, 'draft', ${oldVersion}, '[{"action":"read","target":"example","conditions":{}}]'::jsonb),
    (${newRole}, ${oldRole}, 2, 'draft', ${replacement}, '[{"action":"read","target":"elsewhere","conditions":{}}]'::jsonb)`;
   await tx`UPDATE regulation_versions SET status = 'active' WHERE id = ${oldVersion}`;
   await tx`INSERT INTO role_assignments (id, task_id, participant, role_id) VALUES
    (${oldAssignment}, ${task}, ${participant}, ${oldRole}), (${newAssignment}, ${task}, 'reviewer', ${newRole})`;
   const matches = await addRuns(tx, task, [{ sources: ["role"], assignment: oldAssignment }, { sources: [oldRole] }]);
   await addRuns(tx, task, [
    { sources: ["role"], assignment: newAssignment, participant: "reviewer" }, { sources: [randomUUID()], assignment: oldAssignment },
    { sources: ["role"], assignment: oldAssignment, status: "died" }, { sources: null, assignment: oldAssignment },
   ]);
   await tx`UPDATE regulation_versions SET status = 'active' WHERE id = ${replacement}`;
   assert.equal((await tx`SELECT status FROM roles WHERE id = ${oldRole}`)[0]?.status, "superseded");
   assert.equal((await tx`SELECT status FROM roles WHERE id = ${newRole}`)[0]?.status, "active");
   await assertStops(tx, [task], matches);
  });
 } finally { await sql.end(); }
});

it("rights-snapshot: ending an assignment only stops its snapshots of role rights", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl); // af_control does not insert regulation_versions or roles (database.md 535-543)
 const task = randomUUID(), role = randomUUID(), regulation = randomUUID();
 const assignment = randomUUID(), other = randomUUID();
 try {
  await sql.begin(async (tx) => {
   await tx`INSERT INTO tasks (id) VALUES (${task})`;
   await tx`INSERT INTO regulation_versions (id, status) VALUES (${regulation}, 'draft')`;
   await tx`INSERT INTO roles (id, name, version, status, regulation_version_id, rights)
    VALUES (${role}, ${role}, 1, 'draft', ${regulation}, '[{"action":"read","target":"example","conditions":{}}]'::jsonb)`;
   await tx`UPDATE regulation_versions SET status = 'active' WHERE id = ${regulation}`;
   await tx`INSERT INTO role_assignments (id, task_id, participant, role_id) VALUES
    (${assignment}, ${task}, ${participant}, ${role}), (${other}, ${task}, 'reviewer', ${role})`;
   const matches = await addRuns(tx, task, [{ sources: ["role"], assignment }, { sources: [role], assignment }]);
   await addRuns(tx, task, [
    { sources: ["role"], assignment: other, participant: "reviewer" }, { sources: [role] },
    { sources: [randomUUID()], assignment }, { sources: null, assignment }, { sources: ["role"], assignment, status: "failed" },
   ]);
   await tx`UPDATE role_assignments SET superseded_at = now() WHERE id = ${assignment}`;
   await tx`INSERT INTO role_assignments (id, task_id, participant, role_id) VALUES (${randomUUID()}, ${task}, ${participant}, ${role})`;
   await assertStops(tx, [task], matches);
  });
 } finally { await sql.end(); }
});

it("grant-ends and rights-snapshot: suspension stops the agent and ends its grants without reviving them on restore", async () => {
 const db = await bench, sql = connectBench(db.migratorUrl); // answers of both roles in one transaction (database.md 548-549)
 const task = randomUUID(), otherTask = randomUUID(), agent = randomUUID(), otherAgent = randomUUID(), suspension = randomUUID(), session = randomUUID();
 try {
  await sql.begin(async (tx) => {
   await tx`INSERT INTO agents (id) VALUES (${agent}), (${otherAgent})`;
   await tx`INSERT INTO tasks (id) VALUES (${task}), (${otherTask})`;
   const [requester, otherRun] = await addRuns(tx, task, [{ sources: null, agent }, { sources: null, agent: otherAgent }]);
   assert.ok(requester && otherRun);
   const grant = await addGrant(tx, task, requester.run_id);
   const sessionGrant = await addGrant(tx, task, null, session);
   const otherGrant = await addGrant(tx, task, otherRun.run_id);
   const secondAttempt = await addRuns(tx, otherTask, [{ sources: [grant, sessionGrant], agent }]);
   const crossAgent = await addRuns(tx, task, [{ sources: [grant, sessionGrant], agent: otherAgent }]);
   await addRuns(tx, task, [{ sources: [otherGrant], agent: otherAgent }, { sources: [grant], agent, status: "finished" }]);
   const chiefRun = randomUUID();
   await tx`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${chiefRun}, ${task}, ${otherAgent}, 'chief_engineer')`;
   const stopped = [requester, ...secondAttempt, ...crossAgent];
   const suspend = (connection: TransactionSql) => connection`INSERT INTO rights_suspensions (id, agent_id, run_id, event_key, session_ref)
    VALUES (${suspension}, ${agent}, ${requester.run_id}, ${suspension}, ${session})`;
   const assertCriticalGrants = async (connection: TransactionSql) => {
    const grants = await connection`SELECT id, ended_at, ended_by, suspension_id FROM right_grants WHERE id IN (${grant}, ${sessionGrant}, ${otherGrant})`;
    assert.equal(grants.length, 3);
    for (const row of grants) {
     if (row.id === otherGrant) {
      assert.equal(row.ended_at, null);
     } else {
      assert.ok(row.ended_at);
      assert.equal(row.ended_by, "critical");
      assert.equal(row.suspension_id, suspension);
     }
    }
   };
   await assert.rejects(tx.savepoint(async (nested) => {
    await suspend(nested);
    await assertCriticalGrants(nested);
    await assertStops(nested, [task, otherTask], stopped);
    assert.equal((await nested`SELECT id FROM audit_log WHERE action = 'rights.suspend' AND target_id = ${suspension}`).length, 1);
    throw new Error("roll back suspension");
   }), /roll back suspension/);
   assert.equal((await tx`SELECT id FROM rights_suspensions WHERE id = ${suspension}`).length, 0);
   assert.equal((await tx`SELECT id FROM right_grants WHERE id IN (${grant}, ${sessionGrant}) AND ended_at IS NULL`).length, 2);
   await assertStops(tx, [task, otherTask], []);
   await suspend(tx);
   await assertCriticalGrants(tx);
   await assertStops(tx, [task, otherTask], stopped);
   await tx`UPDATE rights_suspensions SET ended_at = now(), restored_by = ${tx.json({ type: "run", id: chiefRun })} WHERE id = ${suspension}`;
   await assertCriticalGrants(tx);
   await assertStops(tx, [task, otherTask], stopped);
  });
 } finally { await sql.end(); }
});
