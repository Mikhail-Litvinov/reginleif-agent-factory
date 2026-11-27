import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { createRegistrySearch } from "../registry/search.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
let setting: (key: string, value: unknown) => Promise<void>;
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
// Russian test data is written as escapes (sources stay free of Cyrillic): record 1 is "green lighthouse lights the harbour".
const greenLighthouse = "\u0417\u0435\u043b\u0451\u043d\u044b\u0439 \u043c\u0430\u044f\u043a \u043e\u0441\u0432\u0435\u0449\u0430\u0435\u0442 \u0433\u0430\u0432\u0430\u043d\u044c";
const lighthouse = "\u043c\u0430\u044f\u043a";
before(async () => {
	const b = await bench;
	await migrate({ url: b.migratorUrl });
	client = connectBench(b.migratorUrl);
	repo = createRepo(drizzle(client));
	setting = async (key, value) => {
		assert.ok(await repo.settings.set(key, value, null), `setting ${key} saved`);
	};
	for (const [n, problem, category] of [[1, greenLighthouse, "sea"], [2, "Amber lantern illuminates harbor", "sea"], [3, "Amber lantern illuminates harbor", "land"]] as const) {
		await repo.registry.records.create({ id: id(n), kind: "decision", authority: "owner", status: "draft", scopeType: "global", category, problem, decision: problem, reuse: "standing", source: "import", createdBy: {} });
		await repo.registry.records.changeStatus(id(n), "active", new Date(), {});
	}
	await repo.registry.embeddings.create({ id: id(4), recordId: id(1), modelVersion: "bench", dimensions: vector.length, embedding: vector });
	await repo.settings.set("registry.embeddingModel", "bench", null);
});
after(async () => { await client?.end(); });

it("searches both languages, typos, vectors, filters and live thresholds", async () => {
	const text = createRegistrySearch(repo, () => undefined);
	const ru = await text({ query: lighthouse, category: "sea" });
	assert.equal(ru.degraded, true);
	assert.ok(ru.items.some(x => x.record.id === id(1) && x.ranking === "fulltext"));
	const en = await text({ query: "amber lantern", category: "sea" });
	assert.ok(en.items.some(x => x.record.id === id(2) && x.ranking === "fulltext"));
	assert.ok(en.items.every(x => x.record.category === "sea"));
	// Trigram threshold: 0.1 keeps the typo hit (similarity of "lantrn" is about 0.14), 0.5 drops it.
	await setting("registry.trigramThreshold", 0.1);
	assert.ok((await text({ query: "lantrn", category: "sea" })).items.some(x => x.record.id === id(2) && x.ranking === "trigram"));
	await setting("registry.trigramThreshold", 0.5);
	assert.ok(!(await text({ query: "lantrn", category: "sea" })).items.some(x => x.record.id === id(2) && x.ranking === "trigram"));
	await setting("registry.trigramThreshold", 0.1846);
	// Full-text threshold: 0.001 keeps the exact-word hit, 1 drops it (ts_rank with normalisation 32 stays below 1).
	await setting("registry.textThreshold", 1);
	assert.ok(!(await text({ query: "amber lantern", category: "sea" })).items.some(x => x.record.id === id(2) && x.ranking === "fulltext"));
	await setting("registry.textThreshold", 0.001);
	assert.ok((await text({ query: "amber lantern", category: "sea" })).items.some(x => x.record.id === id(2) && x.ranking === "fulltext"));
	await setting("registry.textThreshold", 0.025);
	const semantic = createRegistrySearch(repo, () => vector);
	assert.ok((await semantic({ query: "unrelated words", category: "sea" })).items.some(x => x.record.id === id(1) && x.ranking === "vector"));
	await setting("registry.vectorThreshold", 1.01);
	assert.ok(!(await semantic({ query: "unrelated words", category: "sea" })).items.some(x => x.record.id === id(1)));
});
