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
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
before(async () => {
	const b = await bench;
	await migrate({ url: b.migratorUrl });
	client = connectBench(b.migratorUrl);
	repo = createRepo(drizzle(client));
	for (const [n, problem, category] of [[1, "Зелёный маяк освещает гавань", "sea"], [2, "Amber lantern illuminates harbor", "sea"], [3, "Amber lantern illuminates harbor", "land"]] as const) {
		await repo.registry.records.create({ id: id(n), kind: "decision", authority: "owner", status: "draft", scopeType: "global", category, problem, decision: problem, reuse: "standing", source: "import", createdBy: {} });
		await repo.registry.records.changeStatus(id(n), "active", new Date(), {});
	}
	await repo.registry.embeddings.create({ id: id(4), recordId: id(1), modelVersion: "bench", dimensions: vector.length, embedding: vector });
	await repo.settings.set("registry.embeddingModel", "bench", null);
});
after(async () => { await client?.end(); });

it("searches both languages, typos, vectors, filters and live thresholds", async () => {
	const text = createRegistrySearch(repo, () => undefined);
	const ru = await text({ query: "маяк", category: "sea" });
	assert.equal(ru.degraded, true);
	assert.ok(ru.items.some(x => x.record.id === id(1) && x.ranking === "fulltext"));
	const en = await text({ query: "amber lantern", category: "sea" });
	assert.ok(en.items.some(x => x.record.id === id(2) && x.ranking === "fulltext"));
	assert.ok(en.items.every(x => x.record.category === "sea"));
	assert.ok((await text({ query: "lantrn", category: "sea" })).items.some(x => x.record.id === id(2) && x.ranking === "trigram"));
	const semantic = createRegistrySearch(repo, () => vector);
	assert.ok((await semantic({ query: "unrelated words", category: "sea" })).items.some(x => x.record.id === id(1) && x.ranking === "vector"));
	await repo.settings.set("registry.vectorThreshold", 1.01, null);
	assert.ok(!(await semantic({ query: "unrelated words", category: "sea" })).items.some(x => x.record.id === id(1)));
});
