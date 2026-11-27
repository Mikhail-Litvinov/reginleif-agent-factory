import assert from "node:assert/strict";
import { test } from "node:test";
import { applicableRecords, compareAuthority, createRegistryService } from "../registry/service.ts";
import type { Repo } from "../db/repo/index.ts";

const row = (id: string, kind: string, extra: object = {}) => ({ id, kind, authority: kind === "precedent" ? "agent" : "owner", status: "active", scopeType: "global", projectId: null, repository: null, machineId: null, action: null, target: null, reuse: "standing", ...extra });

test("scope excludes other projects, narrowed targets and once records", () => {
	const rows = [row("global", "rule"), row("project", "decision", { scopeType: "project", projectId: "a" }), row("other", "decision", { scopeType: "project", projectId: "b" }), row("repo", "decision", { repository: "other" }), row("target", "decision", { target: "other" }), row("once", "decision", { reuse: "once" })];
	assert.deepEqual(applicableRecords(rows, { projectId: "a", repository: "repo", target: "target" }).map(r => r.id), ["global", "project"]);
});

test("rules outrank decisions and precedents; exceptions only outrank the record named", () => {
	const rule = row("rule", "rule"), decision = row("decision", "decision", { scopeType: "project", projectId: "a" }), precedent = row("precedent", "precedent"), exception = row("exception", "exception");
	assert.equal(compareAuthority(rule, decision, []), 1);
	assert.equal(compareAuthority(decision, precedent, []), 1);
	assert.equal(compareAuthority(exception, decision, [{ fromRecordId: "exception", toRecordId: "decision", linkType: "exception_to" }]), 1);
	assert.equal(compareAuthority(exception, decision, []), 0);
	assert.equal(compareAuthority(row("a", "decision"), row("b", "decision"), []), 0);
});

test("a superseding draft and its link are created in one transaction", async () => {
	const calls: string[] = [];
	const transaction = {
		registry: {
			records: {
				get: async () => ({ id: "old", status: "active" }),
				create: async (input: object) => { calls.push("create"); return input; },
			},
			links: { create: async (input: object) => { calls.push("link"); return input; } },
		},
	};
	const repo = { transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => { calls.push("transaction"); return fn(transaction); } } as unknown as Repo;
	const service = createRegistryService(repo);
	await service.createSupersedingDraft({ type: "owner", id: "owner" }, "old", "link", {
		id: "new", kind: "decision", authority: "owner", status: "draft", scopeType: "global", source: "owner_button",
	});
	assert.deepEqual(calls, ["transaction", "create", "link"]);
});

test("record proposals cannot impersonate owner or relay sources", async () => {
	const service = createRegistryService({} as Repo);
	const actor = { type: "agent" as const, id: "agent" };
	const base = { id: "new", kind: "decision", authority: "agent", status: "draft", scopeType: "global" };
	for (const source of ["owner_button", "owner_message", "poll_press", "orchestrator"]) {
		await assert.rejects(service.createRecord(actor, { ...base, source }), { reason: "forbidden" });
	}
});

test("facts and precedents require evidence", async () => {
	const service = createRegistryService({} as Repo);
	const actor = { type: "agent" as const, id: "agent" };
	for (const kind of ["fact", "precedent"]) {
		for (const evidence of [undefined, [], {}]) {
			await assert.rejects(service.createRecord(actor, { id: "new", kind, authority: "agent", status: "draft", scopeType: "global", source: "agent_proposal", evidence }), { reason: "evidence_missing" });
		}
	}
});

test("opening an inquiry stores search results in the same transaction", async () => {
	const calls: string[] = [];
	const transaction = { registry: {
		lock: async () => {},
		regulations: { active: async () => undefined },
		records: { ruleIds: async () => [] },
		inquiries: { create: async () => { calls.push("inquiry"); return { id: "inquiry" }; } },
		results: { create: async (input: object) => { calls.push("result"); return input; } },
	} };
	const repo = { transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => { calls.push("transaction"); return fn(transaction); } } as unknown as Repo;
	const service = createRegistryService(repo, async () => {
		calls.push("search");
		return [{ id: "result", recordId: "record", recordVersion: 1, foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: [] }];
	});
	await service.openInquiry({ type: "owner", id: "owner" }, { id: "inquiry", problem: "problem", category: "general" });
	assert.deepEqual(calls, ["transaction", "inquiry", "search", "result"]);
});
