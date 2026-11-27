import assert from "node:assert/strict";
import { it } from "node:test";
import { createRegistryGate } from "../registry/gate.ts";

const actor = { tokenId: "token", sessionRef: "session" };
// Arbitrary fixture inquiry number and timeout setting, not production defaults.
const inquiry = { id: "inquiry", number: 7, tokenId: "token", sessionRef: "session", runId: null, projectId: null };
const record = (id: string) => ({ id, version: 1 });
const hit = (id: string) => ({ record: record(id), score: 1, ranking: "fulltext" as const, matchedFields: [] });

function fixture() {
	let fire = () => {};
	const events: string[] = [];
	const results: any[] = [];
	const records = new Map<string, any>();
	let found: any[] = [];
	const repo: any = { registry: {
		inquiries: { get: async (id: string) => id === inquiry.id ? inquiry : undefined },
		results: { forInquiry: async () => results, create: async (r: any) => { results.push(r); return r; } },
		records: { get: async (id: string) => records.get(id) },
	} };
	const search = async (input: any) => { events.push(input.query); return { items: found, degraded: false }; };
	const gate = createRegistryGate(repo, search, { timeoutMs: 40, timer: { set: (fn: () => void, ms: number) => { assert.equal(ms, 40); fire = fn; return 1; }, clear: () => {} }, recordFailOpen: () => events.push("fail-open") });
	return { gate, results, records, events, fire: () => fire(), setFound: (items: any[]) => { found = items; } };
}

it("refuses missing and foreign inquiries", async () => {
	const f = fixture();
	assert.deepEqual(await f.gate(actor, { inquiryId: "missing", question: "Question" }), { pass: false, records: [] });
	assert.deepEqual(await f.gate({ ...actor, sessionRef: "other" }, { inquiryId: inquiry.id, question: "Question" }), { pass: false, records: [] });
});

it("refuses open and applies verdicts and passes the other verdicts", async () => {
	for (const verdict of [null, "applies", "not_applicable", "outdated", "conflict"]) {
		const f = fixture(); f.records.set("r", record("r")); f.results.push({ recordId: "r", verdict });
		const answer = await f.gate(actor, { inquiryId: inquiry.id, question: "Question" });
		assert.deepEqual(answer, verdict === null || verdict === "applies" ? { pass: false, records: [record("r")] } : { pass: true });
	}
});

it("searches the real question and attaches newly found records without overwriting verdicts", async () => {
	const f = fixture(); f.records.set("old", record("old")); f.results.push({ recordId: "old", verdict: "not_applicable" });
	f.setFound([hit("old"), hit("new")]);
	assert.deepEqual(await f.gate(actor, { inquiryId: inquiry.id, question: "Different wording" }), { pass: false, records: [record("new")] });
	assert.deepEqual(f.events, ["Different wording"]);
	assert.equal(f.results.length, 2); assert.equal(f.results[1].foundBy, "gate");
});

it("passes and records a timeout without waiting for the search", async () => {
	const f = fixture();
	const pending = createRegistryGate({ registry: { inquiries: { get: async () => inquiry }, results: { forInquiry: async () => [] } } } as any, () => new Promise(() => {}), { timeoutMs: 40, timer: { set: (fn: () => void) => { queueMicrotask(fn); return 1; }, clear: () => {} }, recordFailOpen: () => f.events.push("fail-open") });
	assert.deepEqual(await pending(actor, { inquiryId: inquiry.id, question: "Question" }), { pass: true });
	assert.deepEqual(f.events, ["fail-open"]);
});

it("records an unavailable search and passes", async () => {
	const f = fixture();
	const gate = createRegistryGate({ registry: { inquiries: { get: async () => inquiry }, results: { forInquiry: async () => [] } } } as any, async () => { throw new Error("offline"); }, { timeoutMs: 40, timer: { set: () => 1, clear: () => {} }, recordFailOpen: event => f.events.push(event.reason) });
	assert.deepEqual(await gate(actor, { inquiryId: inquiry.id, question: "Question" }), { pass: true });
	assert.deepEqual(f.events, ["unavailable"]);
});
