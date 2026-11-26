import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let dir: string;
const file = (name: string, sql: string) => writeFile(join(dir, name), sql);

describe("migrations", () => {
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "af-migrate-"));
		const sql = connectBench((await bench).migratorUrl);
		try { await sql`DROP TABLE IF EXISTS public.af_test_migration, public.af_migrations`; } finally { await sql.end(); }
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
	const run = async () => migrate({ url: (await bench).migratorUrl, migrationsDir: dir });

	it("applies files in order and a second run is a no-op", async () => {
		await file("0002_second.sql", "INSERT INTO af_test_migration VALUES (2);");
		await file("0001_first.sql", "CREATE TABLE af_test_migration (id int); INSERT INTO af_test_migration VALUES (1);");
		assert.deepEqual(await run(), ["0001_first.sql", "0002_second.sql"]);
		assert.deepEqual(await run(), []);
		const sql = connectBench((await bench).migratorUrl);
		try { assert.deepEqual((await sql`SELECT id FROM af_test_migration ORDER BY id`).map((row) => row.id), [1, 2]); } finally { await sql.end(); }
	});
	it("refuses changed or renamed applied files and missing history", async () => {
		await file("0001_first.sql", "SELECT 1;");
		await run();
		await file("0001_first.sql", "SELECT 2;");
		await assert.rejects(run(), /checksum/i);
		await rm(join(dir, "0001_first.sql"));
		await assert.rejects(run(), /missing|history/i);
		await file("0001_other.sql", "SELECT 1;");
		await assert.rejects(run(), /name|history/i);
	});
	it("refuses gaps and duplicate numbers before executing SQL", async () => {
		await file("0002_second.sql", "SELECT 1;");
		await assert.rejects(run(), /gap/i);
		await file("0001_first.sql", "SELECT 1;");
		await file("0001_duplicate.sql", "SELECT 1;");
		await assert.rejects(run(), /duplicate/i);
	});
	it("refuses a non-prefix applied history", async () => {
		await file("0001_first.sql", "SELECT 1;");
		await file("0002_second.sql", "SELECT 2;");
		await run();
		const sql = connectBench((await bench).migratorUrl);
		try { await sql`DELETE FROM public.af_migrations WHERE number = 1`; } finally { await sql.end(); }
		await assert.rejects(run(), /order|history/i);
	});
	it("serializes concurrent runs and records each file once", async () => {
		await file("0001_first.sql", "CREATE TABLE af_test_migration (id int); INSERT INTO af_test_migration VALUES (1);");
		const results = await Promise.all([run(), run()]);
		assert.deepEqual(results.map((result) => result.length).sort(), [0, 1]);
		const sql = connectBench((await bench).migratorUrl);
		try { assert.equal((await sql`SELECT count(*)::int AS count FROM af_test_migration`)[0]?.count, 1); } finally { await sql.end(); }
	});
	it("rolls back a failed file", async () => {
		await file("0001_first.sql", "CREATE TABLE af_test_migration (id int); SELECT 1/0;");
		await assert.rejects(run());
		const sql = connectBench((await bench).migratorUrl);
		try { assert.equal((await sql`SELECT to_regclass('public.af_test_migration') AS name`)[0]?.name, null); } finally { await sql.end(); }
	});
});

it("rejects invalid CLI arguments with status 2", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../db/migrate.ts", import.meta.url)), "--unknown"], { encoding: "utf8" });
	assert.equal(result.status, 2);
});
