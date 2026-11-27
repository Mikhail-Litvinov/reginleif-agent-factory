import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

// drizzle(sql) replaces the json serializers of the postgres.js client it wraps (drizzle-orm 0.45.4 over postgres 3.4.9),
// so a test that calls sql.json() on such a client fails with ERR_INVALID_ARG_TYPE, and which clients are wrapped changes
// as tests change. Tests therefore never call the postgres.js json helper: they use jsonb() from database-bench.ts.
// The pattern is assembled so that this file does not match itself.
const direct = new RegExp("\\b(?:sql|tx|admin|db|pg|client|conn|bench)\\" + ".json\\(");

const sources = async (dir: string): Promise<string[]> => {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...await sources(path));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
};

it("no test calls the postgres.js json helper directly", async () => {
	const root = fileURLToPath(new URL(".", import.meta.url));
	const offenders: string[] = [];
	for (const path of await sources(root)) {
		const lines = (await readFile(path, "utf8")).split(/\r?\n/);
		lines.forEach((line, index) => { if (!line.trimStart().startsWith("//") && direct.test(line)) offenders.push(`${path.slice(root.length)}:${index + 1}`); });
	}
	assert.deepEqual(offenders, [], "use jsonb(value) with a ::jsonb cast (tests/database-bench.ts) instead of the client's json helper");
});

it("the scan pattern catches the direct call it forbids", () => {
	assert.ok(direct.test("await sql`UPDATE t SET v = ${" + "sql" + ".json({ a: 1 })}`"));
	assert.ok(!direct.test("const body = await response.json() as { id: string };"));
});
