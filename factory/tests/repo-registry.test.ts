import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { RegistryRefusedError } from "../db/repo/registry.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const benchPromise = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let repo: ReturnType<typeof createRepo>;

before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	client = connectBench(bench.migratorUrl);
	db = drizzle(client);
	repo = createRepo(db);
});
after(async () => { await client?.end(); });

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const record = (n: number, problem: string, decision: string) => ({
	id: id(n), kind: "decision", authority: "owner", status: "draft", scopeType: "global", category: "general",
	problem, decision, reuse: "standing", version: 1, source: "import", createdBy: { type: "test" },
});

describe("registry repositories", () => {
	it("creates and reads regulation versions and writes an audit row on status change", async () => {
		const created = await repo.registry.regulations.create({ id: id(1), status: "draft", clauses: [], clausesBytes: 0, proposedBy: { type: "test" } });
		assert.equal((await repo.registry.regulations.get(created.id))?.status, "draft");
		assert.equal((await repo.registry.regulations.list({ status: "draft" })).some((row) => row.id === created.id), true);
		const changed = await repo.registry.regulations.changeStatus(created.id, { status: "revoked", statusChangedAt: new Date() });
		assert.equal(changed?.status, "revoked");
		assert.equal((await repo.registry.regulations.history(created.id)).some((row) => row.action === "regulation.status"), true);
		assert.equal(await repo.registry.regulations.active(), undefined);
	});

	it("creates inquiries, registers one poll and reads inquiries", async () => {
		const inquiry = await repo.registry.inquiries.create({ id: id(2), problem: "problem", category: "general", reuseIntent: "once" });
		assert.equal((await repo.registry.inquiries.get(inquiry.id))?.id, inquiry.id);
		assert.equal((await repo.registry.inquiries.list({ limit: 1 })).some((row) => row.id === inquiry.id), true);
		const poll = await repo.registry.inquiries.registerPoll(inquiry.id, { pollQuestion: "question", pollOptions: [], pollRegisteredAt: new Date() });
		assert.equal(poll?.pollQuestion, "question");
		assert.equal(await repo.registry.inquiries.registerPoll(inquiry.id, { pollQuestion: "replacement", pollOptions: [], pollRegisteredAt: new Date() }), null);
	});

	it("creates and reads records, writes status audit and maps immutable-field refusals", async () => {
		const created = await repo.registry.records.create(record(3, "registry cobalt phrase", "keep the cobalt sample safe"));
		assert.equal((await repo.registry.records.get(created.id))?.id, created.id);
		assert.equal((await repo.registry.records.byNumber(created.number))?.id, created.id);
		assert.equal((await repo.registry.records.list({ category: "general" })).some((row) => row.id === created.id), true);
		await assert.rejects(repo.registry.records.updateContent(created.id, { problem: "changed" }), (error) =>
			error instanceof RegistryRefusedError && error.reason === "registry_records content is immutable");
		assert.equal((await repo.registry.records.changeStatus(created.id, "rejected", new Date(), { id: id(9) }))?.status, "rejected");
		assert.equal((await repo.registry.records.history(created.id)).some((row) => row.action === "registry.status"), true);
	});

	it("consumes a single-use permission once", async () => {
		const permission = await repo.registry.records.create({
			id: id(4), kind: "permission", authority: "owner", status: "draft", scopeType: "global", category: "rights",
			reuse: "once", source: "owner_button", right: { action: "read", target: "file", conditions: {} }, createdBy: { type: "owner" },
		});
		assert.ok((await repo.registry.records.consumePermission(permission.id, new Date()))?.consumedAt);
		assert.equal(await repo.registry.records.consumePermission(permission.id, new Date()), null);
	});

	it("creates links and returns links touching a record", async () => {
		const from = await repo.registry.records.create(record(5, "from", "from"));
		const to = await repo.registry.records.create(record(6, "to", "to"));
		const link = await repo.registry.links.create({ id: id(7), fromRecordId: from.id, toRecordId: to.id, linkType: "supersedes", createdBy: { type: "owner" } });
		assert.equal((await repo.registry.links.forRecord(to.id))[0]?.id, link.id);
	});

	it("stores embeddings and searches vectors for the requested model", async () => {
		const target = await repo.registry.records.create(record(8, "vector target", "matching item"));
		const unrelated = await repo.registry.records.create(record(9, "vector unrelated", "different item"));
		const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
		await repo.registry.embeddings.create({ id: id(10), recordId: target.id, modelVersion: "bench-model", dimensions: vector.length, embedding: vector });
		const otherVector = Array.from({ length: 1024 }, (_, index) => index === 1 ? 1 : 0);
		await repo.registry.embeddings.create({ id: id(11), recordId: unrelated.id, modelVersion: "bench-model", dimensions: otherVector.length, embedding: otherVector });
		await repo.registry.embeddings.create({ id: id(17), recordId: unrelated.id, modelVersion: "other-model", dimensions: vector.length, embedding: vector });
		assert.equal((await repo.registry.embeddings.forRecord(target.id, "bench-model")).length, 1);
		const hits = await repo.registry.embeddings.searchVector({ embedding: vector, modelVersion: "bench-model", query: "unused", limit: 5, threshold: 0 });
		assert.equal(hits[0]?.record.id, target.id);
		assert.ok(hits[0]!.score >= hits[1]!.score);
		assert.deepEqual(await repo.registry.embeddings.searchVector({ embedding: vector, modelVersion: "bench-model", query: "unused", limit: 5, threshold: 1.01 }), []);
	});

	it("searches full text and trigrams by score, limit and threshold", async () => {
		const first = await repo.registry.records.create(record(12, "tungsten registry phrase", "preserve the tungsten sample"));
		const second = await repo.registry.records.create(record(13, "tungsten registry phrase", "preserve the tungsten sample carefully"));
		const fullText = await repo.registry.records.searchFullText({ query: "tungsten registry", language: "en", limit: 5, threshold: 0 });
		assert.equal(fullText.length, 2);
		assert.ok(fullText[0]!.score >= fullText[1]!.score);
		assert.deepEqual(await repo.registry.records.searchFullText({ query: "tungsten registry", language: "en", limit: 5, threshold: 1_000_000 }), []);
		const trigram = await repo.registry.records.searchTrigram({ query: "tungsten registry phrase", limit: 2, threshold: 0 });
		assert.deepEqual(trigram.map((hit) => hit.record.id), [first.id, second.id]);
		assert.ok(trigram[0]!.score >= trigram[1]!.score);
		assert.deepEqual(await repo.registry.records.searchTrigram({ query: "tungsten registry phrase", limit: 5, threshold: 1.01 }), []);
	});

	it("creates inquiry results and records a verdict once", async () => {
		const inquiry = await repo.registry.inquiries.create({ id: id(14), problem: "problem", category: "general", reuseIntent: "standing" });
		const found = await repo.registry.records.create(record(15, "result", "result"));
		const result = await repo.registry.results.create({
			id: id(16), inquiryId: inquiry.id, recordId: found.id, recordVersion: 1, foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: [],
		});
		assert.equal((await repo.registry.results.forInquiry(inquiry.id))[0]?.id, result.id);
		assert.equal((await repo.registry.results.setVerdict(result.id, { verdict: "applies", verdictAt: new Date() }))?.verdict, "applies");
		assert.equal(await repo.registry.results.setVerdict(result.id, { verdict: "outdated", difference: "changed", verdictAt: new Date() }), null);
	});
});
