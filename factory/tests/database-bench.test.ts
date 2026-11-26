import assert from "node:assert/strict";
import { test } from "node:test";
import { connectBench, databaseBench, databaseNameForFile } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);

test("test files get isolated databases and the bench clock advances without waiting", async () => {
	const current = await bench;
	const otherFile = databaseNameForFile(current.runId, new URL("./database-bench-peer.test.ts", import.meta.url).href);
	assert.notEqual(current.database, otherFile);

	const migrator = connectBench(current.migratorUrl);
	const api = connectBench(current.apiUrl);
	try {
		await migrator`CREATE TABLE bench_example (value text NOT NULL)`;
		await migrator`INSERT INTO bench_example (value) VALUES ('round trip')`;
		await migrator`GRANT SELECT ON bench_example TO af_api`;
		const rows = await api`SELECT value FROM bench_example`;
		assert.deepEqual(rows.map((row) => row.value), ["round trip"]);
	} finally {
		await Promise.all([migrator.end(), api.end()]);
	}

	assert.equal(current.clock.now(), 0);
	await current.clock.sleep(250);
	assert.equal(current.clock.now(), 250);
});
