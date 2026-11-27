import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedderClient, httpEmbedderTransport } from "../registry/embedder-client.ts";

test("stamps vectors, batches stale records, resumes and serializes workers", async () => {
	const rows = ["a", "b", "c"].map(id => ({ id, text: id }));
	const saved = new Map<string, string>();
	let tail = Promise.resolve();
	const repo = { transaction: async (fn: any) => {
		const before = tail; let release!: () => void;
		tail = new Promise<void>(resolve => { release = resolve; });
		await before;
		try { return await fn({ registry: { embeddings: {
			lockReembedding: async () => {},
			pendingReembedding: async (version: string, limit: number) => rows.filter(row => saved.get(row.id) !== version).slice(0, limit),
			create: async (entry: any) => { assert.equal(entry.dimensions, 1024); saved.set(entry.recordId, entry.modelVersion); },
		} } }); } finally { release(); }
	} };
	const calls: string[][] = [];
	const transport = async (texts: string[]) => { calls.push(texts); return { model: "BAAI/bge-m3", revision: "rev", sha256: "hash", vectors: texts.map(() => Array(1024).fill(1)) }; };
	const client = createEmbedderClient(repo as any, transport, () => new Date(0));
	assert.equal(await client.reembedBatch("rev", 2), 2);
	assert.deepEqual([...saved.values()], ["rev", "rev"]);
	assert.deepEqual(await Promise.all([client.reembedBatch("rev", 2), client.reembedBatch("rev", 2)]), [1, 0]);
	assert.deepEqual(calls, [["a", "b"], ["c"]]);
	assert.equal(await client.reembedBatch("next", 2).catch(() => -1), -1);
});

test("HTTP transport sends a batch and store stamps the service version", async () => {
	let stored: any;
	const repo = { transaction: async (fn: any) => fn({ registry: { embeddings: { create: async (value: any) => { stored = value; } } } }) };
	const fetcher: typeof fetch = async (url, init) => {
		assert.equal(String(url), "http://localhost:8088/embed");
		assert.deepEqual(JSON.parse(String(init?.body)), { texts: ["hello"] });
		return new Response(JSON.stringify({ model: "BAAI/bge-m3", revision: "rev", sha256: "hash", vectors: [Array(1024).fill(1)] }));
	};
	const client = createEmbedderClient(repo as any, httpEmbedderTransport("http://localhost:8088", fetcher), () => new Date(0));
	await client.store("record", "hello", "rev");
	assert.equal(stored.recordId, "record");
	assert.equal(stored.modelVersion, "rev");
	assert.equal(stored.createdAt.getTime(), 0);
});

test("background worker reads the target model again on every pass and survives a failed read", async () => {
	// The target is a setting an owner can change while the process runs (registry.embeddingModel); a value read once at start would keep embedding toward the old model.
	const asked: string[] = [];
	const repo = { transaction: async (fn: any) => fn({ registry: { embeddings: { lockReembedding: async () => {}, pendingReembedding: async (version: string) => { asked.push(version); return []; } } } }) };
	const client = createEmbedderClient(repo as any, async () => { throw Error("unexpected"); });
	let target: string | Error = "rev-1";
	const errors: unknown[] = [];
	let scheduled = 0;
	let run!: () => void;
	const stop = client.startBackground(async () => { if (target instanceof Error) throw target; return target; }, 5, 100, {
		schedule: callback => { scheduled++; run = callback; return () => {}; },
		onError: error => { errors.push(error); },
	});
	const pass = async () => { run(); await new Promise(resolve => setImmediate(resolve)); };
	await pass();
	target = "rev-2";
	await pass();
	target = new Error("settings unavailable");
	await pass();
	target = "rev-3";
	await pass();
	stop();
	assert.deepEqual(asked, ["rev-1", "rev-2", "rev-3"]);
	assert.equal(errors.length, 1);
	assert.equal(scheduled, 5, "the failed read still schedules the next pass");
});

test("background worker schedules work without overlapping and can stop", async () => {
	let run: (() => void) | undefined;
	let cancel = false;
	let batches = 0;
	const repo = { transaction: async (fn: any) => fn({ registry: { embeddings: { lockReembedding: async () => {}, pendingReembedding: async () => { batches++; return []; } } } }) };
	const client = createEmbedderClient(repo as any, async () => { throw Error("unexpected"); });
	const stop = client.startBackground("rev", 5, 100, { schedule: callback => { run = callback; return () => { cancel = true; }; }, onError: error => { throw error; } });
	assert.ok(run);
	run();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(batches, 1);
	stop();
	assert.equal(cancel, true);
});
