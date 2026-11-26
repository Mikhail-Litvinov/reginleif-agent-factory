import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
it("applies migration 0004", async () => {
	const db = await bench;
	const applied = await migrate({ url: db.migratorUrl });
	assert.match(applied[3] ?? "", /^0004_.*\.sql$/);
});

it("enforces run references, workspace exclusivity and immutable streams", async () => {
	const db = await bench, sql = connectBench(db.migratorUrl);
	const task = randomUUID(), other = randomUUID(), run = randomUUID(), event = randomUUID(), artifact = randomUUID(), check = randomUUID();
	try {
		await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0), (${other}, 0)`;
		await sql`INSERT INTO task_runs (id, task_id, role) VALUES (${run}, ${task}, 'implementer')`;
		await sql`INSERT INTO tasks (id, depth, origin_task_id, origin_run_id) VALUES (${randomUUID()}, 0, ${task}, ${run})`;
		await assert.rejects(sql`UPDATE task_runs SET task_id = ${other} WHERE id = ${run}`, /origin run/i);
		await assert.rejects(sql`INSERT INTO tasks (id, depth, origin_task_id, origin_run_id) VALUES (${randomUUID()}, 0, ${other}, ${run})`, /origin run/i);
		await assert.rejects(sql`INSERT INTO tasks (id, depth, origin_task_id, origin_run_id) VALUES (${randomUUID()}, 0, ${task}, ${randomUUID()})`, /origin run|foreign key/i);
		await sql`INSERT INTO workspaces (id, worktree_path, state) VALUES (${randomUUID()}, '/test/path', 'in_use'), (${randomUUID()}, '/test/path', 'done')`;
		await assert.rejects(sql`INSERT INTO workspaces (id, worktree_path, state) VALUES (${randomUUID()}, '/test/path', 'in_use')`, /unique/i);
		const xid = await sql.begin(async tx => {
			const rows = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
			await tx`INSERT INTO task_events (id, task_id, run_id) VALUES (${event}, ${task}, ${run})`;
			return rows[0]!.xid;
		});
		assert.equal((await sql<{ xid: string }[]>`SELECT commit_xid::text AS xid FROM task_events WHERE id = ${event}`)[0]?.xid, xid);
		await sql`INSERT INTO task_artifacts (id, run_id, upload_state, checksum) VALUES (${artifact}, ${run}, 'confirmed', 'abc')`;
		await sql`INSERT INTO run_checks (id, run_id) VALUES (${check}, ${run})`;
		await assert.rejects(sql`UPDATE task_events SET event_type = 'changed' WHERE id = ${event}`, /immutable/i);
		await assert.rejects(sql`DELETE FROM run_checks WHERE id = ${check}`, /immutable/i);
		await assert.rejects(sql`UPDATE task_artifacts SET checksum = 'changed' WHERE id = ${artifact}`, /immutable/i);
		await sql`UPDATE task_artifacts SET upload_state = 'removed', removed_at = now() WHERE id = ${artifact}`;
		await assert.rejects(sql`UPDATE task_artifacts SET upload_state = 'confirmed' WHERE id = ${artifact}`, /immutable/i);
		await assert.rejects(sql`INSERT INTO task_decisions (id, task_id, engineer_run_id, kind, channel, delivery_state) VALUES (${randomUUID()}, ${task}, ${run}, 'physical_decision', 'api', 'applied')`, /chief engineer run/i);
	} finally { await sql.end(); }
});

it("grants mutable, immutable and backup access by role", async () => {
	const db = await bench;
	for (const [role, url] of [["api", db.apiUrl], ["control", db.controlUrl], ["backup", db.backupUrl]] as const) {
		const sql = connectBench(url);
		try {
			for (const table of ["workspaces", "task_runs", "task_events", "task_artifacts", "run_checks"]) {
				await sql.unsafe(`SELECT * FROM ${table} LIMIT 0`);
				await assert.rejects(sql.unsafe(`DELETE FROM ${table}`), /permission denied/i);
			}
			if (role === "backup") await assert.rejects(sql`INSERT INTO workspaces (id) VALUES (${randomUUID()})`, /permission denied/i);
			else { await sql`INSERT INTO workspaces (id) VALUES (${randomUUID()})`; await assert.rejects(sql`UPDATE task_events SET event_type = 'x'`, /permission denied/i); }
			if (role === "api") await assert.rejects(sql`UPDATE task_runs SET status = 'running'`, /permission denied/i);
			if (role === "control") await sql`UPDATE task_runs SET status = 'running' WHERE false`;
		} finally { await sql.end(); }
	}
});
