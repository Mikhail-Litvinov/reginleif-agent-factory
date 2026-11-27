import assert from "node:assert/strict";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);

// The seeded system task of migration 0007 (the standing task that owns the factory's own runs).
const SYSTEM_TASK = "00000000-0000-4000-8000-000000000008";

it("applies migration 0009 once and gives the seeded standing task its initial revision", async () => {
	const db = await bench;
	const applied = await migrate({ url: db.migratorUrl });
	assert.equal(applied.some((name) => name.startsWith("0009_")), true, "0009 is applied on a fresh database");
	assert.deepEqual(await migrate({ url: db.migratorUrl }), []);
	const sql = connectBench(db.migratorUrl);
	try {
		const task = await sql<{ current_revision: number | null }[]>`SELECT current_revision FROM tasks WHERE id = ${SYSTEM_TASK}`;
		assert.deepEqual(task.map((row) => row.current_revision), [1], "the standing task points at revision 1");
		const revisions = await sql<{ revision_number: number; change_reason: string }[]>`
			SELECT revision_number, change_reason FROM task_revisions WHERE task_id = ${SYSTEM_TASK} ORDER BY revision_number`;
		assert.deepEqual(revisions.map((row) => ({ number: row.revision_number, reason: row.change_reason })), [{ number: 1, reason: "initial" }]);
	} finally { await sql.end(); }
});

it("running the 0009 statements again neither duplicates the revision nor moves the version", async () => {
	const db = await bench;
	await migrate({ url: db.migratorUrl });
	const sql = connectBench(db.migratorUrl);
	try {
		const before = await sql<{ row_version: number }[]>`SELECT row_version FROM tasks WHERE id = ${SYSTEM_TASK}`;
		const { readFile } = await import("node:fs/promises");
		const text = await readFile(new URL("../db/migrations/0009_standing_revision.sql", import.meta.url), "utf8");
		await sql.unsafe(text);
		const count = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM task_revisions WHERE task_id = ${SYSTEM_TASK}`;
		assert.deepEqual(count.map((row) => row.n), ["1"]);
		const after = await sql<{ row_version: number }[]>`SELECT row_version FROM tasks WHERE id = ${SYSTEM_TASK}`;
		assert.deepEqual(after, before);
	} finally { await sql.end(); }
});
