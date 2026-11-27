import assert from "node:assert/strict";
import { it } from "node:test";
import { createRegistrySearch } from "../registry/search.ts";
import type { Repo } from "../db/repo/index.ts";

it("passes filters and settings to the vector and text rankings and merges without comparing unlike scores", async () => {
	const calls: any[] = [];
	const values: Record<string, unknown> = {};
	const hit = (id: string, score: number) => ({ record: { id }, score, matchedFields: [] });
	const repo = {
		settings: { snapshot: async () => values },
		registry: { records: {
			searchFullText: async (x: any) => { calls.push(x); return (x.language === "ru" ? [hit("text", 0.03)] : [hit("text", 0.04)]).filter(h => h.score >= x.threshold); },
			searchTrigram: async () => { throw new Error("trigram must stay out of the ranking path while the embedder works"); },
		}, embeddings: { searchVector: async (x: any) => { calls.push(x); return [hit("vector", 0.5)].filter(h => h.score >= x.threshold); } } },
	} as unknown as Pick<Repo, "settings" | "registry">;
	const search = createRegistrySearch(repo, async () => [1, 0]);
	const result = await search({ query: "query", projectId: "project", category: "general", limit: 3 });
	assert.deepEqual(result.items.map(x => [x.record.id, x.ranking, x.score]), [["vector", "vector", 0.5], ["text", "fulltext", 0.04]]);
	assert.equal(result.degraded, false);
	assert.ok(calls.every(x => x.projectId === "project" && x.category === "general" && x.status === "active" && x.reuse === "standing"));
	assert.deepEqual(calls.map(x => x.threshold), [0.025, 0.025, 0.47]);
	assert.deepEqual(calls[2].embedding, [1, 0]);
	values["registry.vectorThreshold"] = 0.8;
	values["registry.embeddingModel"] = "new-model";
	const dropped = await search({ query: "query" });
	assert.equal(calls[5].threshold, 0.8);
	assert.equal(calls[5].modelVersion, "new-model");
	assert.ok(result.items.some(x => x.record.id === "vector"), "vector 0.5 is kept at the default 0.47");
	assert.ok(!dropped.items.some(x => x.record.id === "vector"), "vector 0.5 is dropped at 0.8");
});

it("uses trigram only as the degraded-mode typo fallback, with its live threshold", async () => {
	const calls: any[] = [];
	const values: Record<string, unknown> = {};
	const hit = (id: string, score: number) => ({ record: { id }, score, matchedFields: ["problem"] });
	const repo = {
		settings: { snapshot: async () => values },
		registry: { records: {
			searchFullText: async (x: any) => (x.language === "en" ? [hit("text", 0.04)] : []),
			searchTrigram: async (x: any) => { calls.push(x); return [hit("text", 0.9), hit("typo", 0.2)].filter(h => h.score >= x.threshold); },
		}, embeddings: { searchVector: () => { throw new Error("unexpected"); } } },
	} as unknown as Pick<Repo, "settings" | "registry">;
	const result = await createRegistrySearch(repo, () => null)({ query: "query", projectId: "project" });
	assert.equal(result.degraded, true);
	assert.deepEqual(result.items.map(x => [x.record.id, x.ranking]), [["text", "fulltext"], ["typo", "trigram"]]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].threshold, 0.1846);
	assert.equal(calls[0].projectId, "project");
	values["registry.trigramThreshold"] = 0.5;
	assert.ok(!(await createRegistrySearch(repo, () => undefined)({ query: "query" })).items.some(x => x.ranking === "trigram" && x.record.id === "typo"), "0.2 is dropped at 0.5");
});

it("marks unavailable embeddings degraded and omits the vector call", async () => {
	const repo = { settings: { snapshot: async () => ({}) }, registry: { records: { searchFullText: async () => [], searchTrigram: async () => [] }, embeddings: { searchVector: () => { throw new Error("unexpected"); } } } } as unknown as Pick<Repo, "settings" | "registry">;
	assert.deepEqual(await createRegistrySearch(repo, () => undefined)({ query: "query" }), { items: [], degraded: true });
});
