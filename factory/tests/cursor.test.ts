import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCursor, encodeCursor, readStreamPage, streamSource, streams } from "../api/cursor.ts";

describe("cursor unit", () => {
	it("round trips each stream and rejects foreign and malformed cursors", () => {
		for (const stream of ["task_events", "audit_log", "notifications", "messages"] as const) {
			const cursor = encodeCursor(stream, { commitXid: "18446744073709551615", seq: 9223372036854775807n });
			assert.deepEqual(decodeCursor(stream, cursor), { commitXid: "18446744073709551615", seq: 9223372036854775807n });
			assert.throws(() => decodeCursor(stream === "messages" ? "audit_log" : "messages", cursor), { code: "bad_cursor", status: 400 });
		}
		for (const cursor of ["", "!", "eyJ2IjoxfQ", "e30=", Buffer.from(JSON.stringify([1, "messages", "-1", "1"])).toString("base64url"), Buffer.from(JSON.stringify([1, "messages", "18446744073709551616", "1"])).toString("base64url")]) {
			assert.throws(() => decodeCursor("messages", cursor), { code: "bad_cursor", status: 400 });
		}
	});
	it("uses one injected horizon and resumes after the delivered row", async () => {
		let calls = 0;
		const rows = [{ commitXid: "10", seq: 1n }, { commitXid: "11", seq: 2n }];
		const source = { snapshotXmin: async () => { calls++; return "11"; }, list: async ({ below, after, limit }: { below: string; after?: { commitXid: string; seq: bigint }; limit: number }) => rows.filter(r => BigInt(r.commitXid) < BigInt(below) && (!after || BigInt(r.commitXid) > BigInt(after.commitXid) || (r.commitXid === after.commitXid && r.seq > after.seq))).slice(0, limit) };
		const first = await readStreamPage("messages", source, { limit: 1 });
		assert.deepEqual(first.items, [rows[0]]);
		assert.equal(calls, 1);
		const second = await readStreamPage("messages", source, { limit: 1, cursor: first.next_cursor! });
		assert.deepEqual(second.items, []);
		assert.equal(second.next_cursor, first.next_cursor);
		assert.equal(calls, 2);
	});
});

// Database bench scenarios are selected separately from the unit tests.
for (const scenario of ["event-cursor", "client-resume"] as const) {
	it(`bench ${scenario}: reverse commits and resume every stream`, async () => {
		const { createDatabaseBench } = await import("./database-bench.ts");
		const { migrate } = await import("../db/migrate.ts");
		const { default: postgres } = await import("postgres");
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { createRepo } = await import("../db/repo/index.ts");
		const bench = await createDatabaseBench(import.meta.url);
		const client = postgres(bench.migratorUrl, { max: 3 });
		try {
			await migrate({ url: bench.migratorUrl });
			const repo = createRepo(drizzle(client));
			for (const [index, stream] of streams.entries()) {
				const early = await client.reserve();
				const late = await client.reserve();
				const ids = [0, 1].map(n => `20000000-0000-7000-8000-${String(index * 2 + n).padStart(12, "0")}`);
				try {
					await early.unsafe("BEGIN");
					await early.unsafe(`INSERT INTO ${stream} (id) VALUES ($1)`, [ids[0]!]);
					await late.unsafe("BEGIN");
					await late.unsafe(`INSERT INTO ${stream} (id) VALUES ($1)`, [ids[1]!]);
					await late.unsafe("COMMIT");
					const source = streamSource(repo, stream);
					const held = await readStreamPage(stream, source, { limit: 1 });
					assert.deepEqual(held.items, []);
					await early.unsafe("COMMIT");
					const first = await readStreamPage(stream, source, { limit: 1 });
					const second = await readStreamPage(stream, source, { limit: 1, cursor: first.next_cursor! });
					const end = await readStreamPage(stream, source, { limit: 1, cursor: second.next_cursor! });
					assert.deepEqual([...first.items, ...second.items].map(row => (row as { id: string }).id), ids);
					assert.deepEqual(end.items, []);
				} finally {
					await early.unsafe("ROLLBACK").catch(() => {});
					await late.unsafe("ROLLBACK").catch(() => {});
					early.release(); late.release();
				}
			}
		} finally { await client.end(); await bench.dispose(); }
	});
}
