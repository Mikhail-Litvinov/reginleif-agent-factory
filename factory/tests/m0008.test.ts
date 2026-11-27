import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);

it("applies migration 0008 once and lets an owner message carry the owner as its principal", async () => {
	const db = await bench;
	const applied = await migrate({ url: db.migratorUrl });
	assert.equal(applied.some((name) => name.startsWith("0008_")), true, "0008 is applied on a fresh database");
	assert.deepEqual(await migrate({ url: db.migratorUrl }), []);
	const sql = connectBench(db.migratorUrl);
	try {
		const owner = randomUUID();
		await sql`INSERT INTO owners (id, name) VALUES (${owner}, 'owner for 0008')`;
		await assert.rejects(
			sql`INSERT INTO messages (id, kind, author, body) VALUES (${randomUUID()}, 'owner', 'owner', 'no principal')`,
			/messages_owner_principal/,
			"an owner message with neither a device session nor an owner is refused",
		);
		await sql`INSERT INTO messages (id, kind, author, body, owner_id) VALUES (${randomUUID()}, 'owner', 'owner', 'from the owner token', ${owner})`;
		await sql`INSERT INTO messages (id, kind, author, body) VALUES (${randomUUID()}, 'status', 'system', 'no principal needed')`;
		await assert.rejects(
			sql`INSERT INTO messages (id, kind, author, body, owner_id) VALUES (${randomUUID()}, 'owner', 'owner', 'unknown owner', ${randomUUID()})`,
			/owner_id/,
			"the owner reference is a real foreign key",
		);
	} finally { await sql.end(); }
});
