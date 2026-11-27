// Requires the disposable database bench, the measurement dataset and a running embedder.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { createRegistrySearch } from "../registry/search.ts";
import { httpEmbedderTransport } from "../registry/embedder-client.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

type Row = { id: string; kind: string; problem: string; decision: string; summary: string; q_cross: string; q_reword: string; q_short: string };
type Dataset = { records: Row[]; unrelated: { q: string }[] };
const bench = databaseBench(import.meta.url);
let connection: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
before(async () => { const db = await bench; await migrate({ url: db.migratorUrl }); connection = connectBench(db.migratorUrl); repo = createRepo(drizzle(connection)); });
after(async () => { await connection?.end(); });

test("registry search with the ONNX container and in degraded mode", async () => {
	const dataset = JSON.parse(await readFile(process.env.REGISTRY_MEASUREMENT_DATASET!, "utf8")) as Dataset;
	const transport = httpEmbedderTransport(process.env.EMBEDDER_URL ?? "http://127.0.0.1:8088");
	const version = "5617a9f61b028005a4858fdac845db406aefb181";
	const ids = new Map<string, string>();
	for (const row of dataset.records) {
		const id = randomUUID(); ids.set(row.id, id);
		// Search uses these passage fields; the measurement set also has kinds absent from this schema.
		// The insert trigger admits an active record only from a poll or the orchestrator, so activate a draft.
		await repo.registry.records.create({ id, kind: "decision", authority: "owner", status: "draft", scopeType: "global", category: "general", problem: row.problem, decision: row.decision, summary: row.summary, reuse: "standing", source: "import", createdBy: { type: "test" } });
		await repo.registry.records.changeStatus(id, "active", new Date(), {});
	}
	for (let i = 0; i < dataset.records.length; i += 8) {
		const rows = dataset.records.slice(i, i + 8);
		const result = await transport(rows.map(row => [row.problem, row.decision, row.summary].join(" ")));
		assert.equal(result.revision, version);
		for (let n = 0; n < rows.length; n++) await repo.registry.embeddings.create({ id: randomUUID(), recordId: ids.get(rows[n]!.id)!, modelVersion: version, dimensions: 1024, embedding: result.vectors[n]! });
	}
	const search = createRegistrySearch(repo, async text => (await transport([text])).vectors[0]);
	const degraded = createRegistrySearch(repo, async () => null);
	let found = 0;
	for (const row of dataset.records) for (const question of [row.q_cross, row.q_reword, row.q_short]) {
		const result = await search({ query: question });
		assert.equal(result.degraded, false);
		if (result.items.some(item => item.record.id === ids.get(row.id))) found++;
		assert.equal((await degraded({ query: question })).degraded, true);
	}
	let falseHits = 0;
	for (const { q } of dataset.unrelated) if ((await search({ query: q })).items.length) falseHits++;
	console.log(JSON.stringify({ registry_search_found: found / (dataset.records.length * 3), registry_search_false_hit: falseHits / dataset.unrelated.length }));
});
