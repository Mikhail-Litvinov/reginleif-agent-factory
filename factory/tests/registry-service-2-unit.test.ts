import assert from "node:assert/strict";
import { test } from "node:test";
import type { Repo } from "../db/repo/index.ts";
import { createRegistryService, sensitiveCategories } from "../registry/service.ts";

test("sensitive categories cover the governance list", () => {
	assert.deepEqual([...sensitiveCategories], ["security", "permissions", "credentials", "publication", "spending", "deletion", "regulation"]);
});

test("regulation proposals always start as drafts and retain their proposer", async () => {
	const { service, versions } = registryFixture();
	const draft = await service.createRegulationDraft(agent, { id: "draft", clauses: [] });
	assert.equal(draft.status, "draft");
	assert.deepEqual(draft.proposedBy, { type: agent.type, id: agent.id });
	assert.deepEqual(draft.conflictReport, { guards: [], records: [] });
	assert.equal(Reflect.get(versions.get(draft.id)!, "conflictReport"), undefined);
	await assert.rejects(service.createRegulationDraft(agent, { id: "active", status: "active", clauses: [] }), { reason: "forbidden" });
});

test("a proposal cannot forge the clause byte count or activation metadata", async () => {
	const { service, records, versions } = registryFixture();
	const clauseId = "01900000-0000-7000-8000-000000000001";
	records.set(clauseId, decision(clauseId, { kind: "rule" }));
	const clauses = [{ id: clauseId, note: "é" }];
	const draft = await service.createRegulationDraft(agent, {
		id: "v", status: "draft", clauses, clausesBytes: 0, number: 123,
		confirmedBy: "forged", confirmationId: "forged", conflictReport: {}, activatedAt: now,
	});
	assert.equal(draft.clausesBytes, Buffer.byteLength(JSON.stringify(clauses)));
	assert.equal(draft.number, 1);
	assert.equal(draft.confirmedBy, undefined);
	assert.equal(draft.confirmationId, undefined);
	assert.equal(Reflect.get(versions.get(draft.id)!, "conflictReport"), undefined);
	assert.equal(draft.activatedAt, undefined);
});

test("regulation size is checked from clauses even if stored metadata is wrong", async () => {
	const clauseId = "01900000-0000-7000-8000-000000000001";
	const { service, versions, records } = registryFixture(Buffer.byteLength("[]"));
	records.set(clauseId, decision(clauseId, { kind: "rule" }));
	await service.createRegulationDraft(agent, { id: "version", clauses: [clauseId] });
	Reflect.set(versions.get("version")!, "clausesBytes", 0);
	const first = await service.requestRegulationConfirmation(owner, "version", { channel: "client", now });
	await assert.rejects(service.activateRegulation(owner, "version", { confirm: `${first.id}.${first.nonce}`, channel: "client", now }), { reason: "regulation_too_large" });
});

test("a regulation cannot bypass its clause limit when the setting is absent", async () => {
	const { service, tx } = registryFixture();
	tx.settings.snapshot = async () => ({ "confirm.windowSeconds": confirmationSeconds });
	const version = await service.createRegulationDraft(agent, { id: "draft", clauses: [] });
	const first = await service.requestRegulationConfirmation(owner, version.id, { channel: "client", now });
	await assert.rejects(service.activateRegulation(owner, version.id, {
		confirm: `${first.id}.${first.nonce}`, channel: "client", now,
	}), { reason: "unavailable" });
});

test("a regulation cannot be activated by an agent or without a second press", async () => {
	const repo = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } as unknown as Repo;
	const service = createRegistryService(repo);
	await assert.rejects(service.activateRegulation(agent, "version"), { reason: "forbidden" });
	await assert.rejects(service.activateRegulation(owner, "version"), { reason: "confirmation_required" });
});

test("regulation activation checks the built-in guards without an external assessor", async () => {
	const { service, records, versions } = registryFixture();
	const clauseId = "01900000-0000-7000-8000-000000000001";
	records.set(clauseId, decision(clauseId, { kind: "rule", decision: "One press is enough" }));
	const draft = await service.createRegulationDraft(agent, { id: "version", clauses: [clauseId] });
	assert.deepEqual(draft.conflictReport, { guards: ["second_press"], records: [] });
	const first = await service.requestRegulationConfirmation(owner, draft.id, { channel: "client", now });
	await assert.rejects(service.activateRegulation(owner, draft.id, { confirm: `${first.id}.${first.nonce}`, channel: "client", now }), { reason: "guard_conflict" });
	assert.equal(versions.get(draft.id)?.status, "draft");
});

test("first regulation press creates an owner-bound expiring confirmation", async () => {
	const { service, tx } = registryFixture();
	await service.createRegulationDraft(owner, { id: "version", clauses: [] });
	const result = await service.requestRegulationConfirmation(owner, "version", { channel: "client", now });
	const row = await tx.confirmations.get(result.id);
	assert.equal(result.expiresAt.getTime(), now.getTime() + confirmationSeconds * 1000);
	assert.equal(row?.actorId, owner.id);
	assert.equal(row?.targetId, "version");
	assert.equal(row?.operation, "regulation_activate");
	assert.equal(row?.id, result.id);
	assert.notEqual(row?.nonceHash, result.nonce);
});

test("an inquiry uses the current regulation rather than the caller's stale version", async () => {
	const { service, versions } = registryFixture();
	versions.set("current", { id: "current", status: "active", number: 1, clauses: [] });
	const { inquiry } = await service.openInquiry(agent, {
		id: "inquiry", tokenId: agent.tokenId, sessionRef: agent.sessionRef,
		regulationVersionId: "old", pollRegisteredAt: now, pollQuestion: "fake", pollOptions: [{ label: "fake" }],
	}, []);
	assert.equal(inquiry.regulationVersionId, "current");
	assert.equal(inquiry.pollRegisteredAt, null);
	assert.equal(inquiry.pollQuestion, null);
	assert.equal(inquiry.pollOptions, null);
});

test("a draft linked to a conflicting active record cannot be activated", async () => {
	const { service, records, links } = registryFixture();
	records.set("old", decision("old", { status: "active" }));
	records.set("new", decision("new"));
	links.push({ fromRecordId: "new", toRecordId: "old", linkType: "conflicts_with" });
	await assert.rejects(service.changeStatus(owner, "new", "active"), { reason: "guard_conflict", conflictsWith: ["old"] });
	assert.equal(records.get("new")?.status, "draft");
});

test("conflict links work in either direction and ignore inactive records", async () => {
	for (const oldStatus of ["active", "superseded"]) {
		const { service, records, links } = registryFixture();
		records.set("old", decision("old", { status: oldStatus }));
		records.set("new", decision("new"));
		links.push({ fromRecordId: "old", toRecordId: "new", linkType: "conflicts_with" });
		if (oldStatus === "active") await assert.rejects(service.changeStatus(owner, "new", "active"), { reason: "guard_conflict" });
		else await service.changeStatus(owner, "new", "active");
		assert.equal(records.get("new")?.status, oldStatus === "active" ? "draft" : "active");
	}
});

const owner = { type: "owner" as const, id: "owner" };
const relay = { type: "relay" as const };
const agent = { type: "agent" as const, id: "agent", tokenId: "token", sessionRef: "session" };
const now = new Date("2030-01-01T00:00:00Z");
const confirmationSeconds = 30;
const decision = (id: string, fields: object = {}) => ({
	id, kind: "decision", authority: "owner", status: "draft", scopeType: "project", projectId: "project",
	category: "formatting", problem: "Tabs or spaces?", decision: "Spaces", reuse: "standing", ...fields,
});

function registryFixture(clauseMaxBytes = 1000, search?: Parameters<typeof createRegistryService>[1]) {
	const records = new Map<string, ReturnType<typeof decision>>();
	type Version = { id: string; status: string; number: number; clauses: unknown[] };
	const versions = new Map<string, Version>();
	const links: { fromRecordId: string; toRecordId: string; linkType: string }[] = [];
	const results: { recordId: string; verdict: string; conflictsWithId?: string }[] = [];
	const inquiry = {
		id: "poll", projectId: "project" as string | null, category: "formatting", reuseIntent: "standing",
		pollQuestion: "Tabs or spaces?", pollOptions: [{ key: "tab", label: "Tabs" }, { key: "space", label: "Spaces" }],
		pollRegisteredAt: now,
	};
	const confirmationRows = new Map<string, Parameters<Repo["confirmations"]["create"]>[0]>();
	const used = new Set<string>();
	const tx = {
		audit: { append: async (row: object) => row },
		owners: { byTelegramUserId: async (id: bigint) => id === 123n ? owner : undefined },
		settings: { snapshot: async (): Promise<Record<string, unknown>> => ({ "confirm.windowSeconds": confirmationSeconds, "registry.clauseMaxBytes": clauseMaxBytes }) },
		confirmations: {
			create: async (row: Parameters<Repo["confirmations"]["create"]>[0]) => confirmationRows.set(row.id, row),
			get: async (id: string) => confirmationRows.get(id),
			consume: async (claim: Parameters<Repo["confirmations"]["consume"]>[0]) => {
				const row = confirmationRows.get(claim.id);
				if (!row || used.has(claim.id) || row.expiresAt! <= claim.now) return null;
				const bindings = ["actorId", "channel", "deviceSessionId", "operation", "targetType", "targetId", "requestHash"] as const;
				if (bindings.some(key => row[key] !== claim[key])) return null;
				used.add(claim.id);
				return row;
			},
		},
		registry: {
			lock: async () => {},
			regulations: {
				get: async (id: string) => versions.get(id),
				active: async () => [...versions.values()].find(row => row.status === "active"),
				nextNumber: async () => Math.max(0, ...[...versions.values()].map(row => row.number)) + 1,
				create: async (row: Version) => {
					versions.set(row.id, row);
					return row;
				},
				changeStatus: async (id: string, patch: { status: string }) => {
					const row = versions.get(id);
					if (!row) return null;
					return Object.assign(row, patch);
				},
			},
			inquiries: {
				get: async (id: string) => id === inquiry.id ? inquiry : undefined,
				create: async (input: object) => input,
				registerPoll: async (id: string, poll: Partial<typeof inquiry>) =>
					id === inquiry.id && !inquiry.pollRegisteredAt ? Object.assign(inquiry, poll) : null,
			},
			records: {
				get: async (id: string) => records.get(id),
				ruleIds: async (ids: string[]) => ids.filter(id => records.get(id)?.kind === "rule"),
				list: async ({ status }: { status: string }) => [...records.values()].filter(row => row.status === status),
				captureByPress: async (pressId: string) => [...records.values()].find(row => Reflect.get(row, "pressId") === pressId),
				captureByInquiry: async (inquiryId: string) => [...records.values()].find(row => Reflect.get(row, "inquiryId") === inquiryId),
				create: async (row: ReturnType<typeof decision>) => { records.set(row.id, row); return row; },
				changeStatus: async (id: string, status: string) => {
					const row = records.get(id);
					if (!row) return null;
					row.status = status;
					return row;
				},
			},
			links: {
				forRecord: async (id: string) => links.filter(link => link.fromRecordId === id || link.toRecordId === id),
				create: async (link: typeof links[number]) => { links.push(link); return link; },
			},
			results: { forInquiry: async () => results, create: async (row: object) => row },
		},
	};
	const repo = { registry: tx.registry, transaction: async (fn: (arg: typeof tx) => unknown) => fn(tx) } as unknown as Repo;
	return { tx, service: createRegistryService(repo, search), records, versions, links, results, inquiry, used };
}

const press = { pollId: "poll", telegramUserId: 123n, optionIndex: 0, pressId: "press" };

test("G2 and G8 capture one offered Telegram answer word for word in its project", async () => {
	const { service, inquiry } = registryFixture();
	const row = await service.capturePoll(relay, press);
	assert.equal(row.status, "active");
	assert.equal(row.scopeType, "project");
	assert.equal(row.projectId, inquiry.projectId);
	assert.equal(row.question, inquiry.pollQuestion);
	assert.deepEqual(row.options, inquiry.pollOptions);
	assert.equal(row.decision, inquiry.pollOptions[0]!.label);
	assert.equal(row.pressedOption, inquiry.pollOptions[0]!.label);
	await assert.rejects(service.capturePoll(relay, press), { reason: "press_replayed" });
	await assert.rejects(service.capturePoll(relay, { ...press, pressId: "another", optionIndex: 1 }), { reason: "poll_closed" });
});

test("G8 refuses a forged, unmapped, unregistered or non-offered Telegram press", async () => {
	const { service, records } = registryFixture();
	await assert.rejects(service.capturePoll(agent, press), { reason: "forbidden" });
	await assert.rejects(service.capturePoll(relay, { ...press, telegramUserId: 999n }), { reason: "forbidden" });
	await assert.rejects(service.capturePoll(relay, { ...press, pollId: "foreign" }), { reason: "not_found" });
	await assert.rejects(service.capturePoll(relay, { ...press, optionIndex: 8 }), { reason: "validation_failed" });
	assert.equal(records.size, 0);
});

test("only the relay registers the displayed poll and it can do so only once", async () => {
	const { service, inquiry } = registryFixture();
	const poll = { question: inquiry.pollQuestion, options: inquiry.pollOptions, now };
	const pendingInquiry = inquiry as { pollRegisteredAt: Date | null };
	pendingInquiry.pollRegisteredAt = null;
	await assert.rejects(service.capturePoll(relay, press), { reason: "not_found" });
	await assert.rejects(service.registerPoll(agent, inquiry.id, poll), { reason: "forbidden" });
	const registration = await service.registerPoll(relay, inquiry.id, poll);
	assert.deepEqual(registration, { pollId: inquiry.id, displayLine: "will be recorded: formatting, project, standing" });
	await assert.rejects(service.registerPoll(relay, inquiry.id, { ...poll, question: "different" }), { reason: "validation_failed" });
	assert.equal((await service.capturePoll(relay, press)).question, poll.question);
});

test("typed and terminal material cannot go around the relay as a forged press or an active proposal", async () => {
	const { service, records } = registryFixture();
	const proposal = decision("draft", { authority: "agent", source: "agent_proposal", decision: "A quotation from the terminal" });
	await assert.rejects(service.createRecord(agent, { ...proposal, status: "active" }), { reason: "forbidden" });
	await assert.rejects(service.createRecord(owner, { ...proposal, authority: "owner", source: "poll_press", pressedOption: "Tabs" }), { reason: "forbidden" });
	await assert.rejects(service.createRecord(agent, { ...proposal, pressId: "fake" }), { reason: "forbidden" });
	assert.equal(records.size, 0);
	assert.equal((await service.createRecord(agent, proposal)).status, "draft");
	assert.equal((await service.changeStatus(owner, proposal.id, "active"))?.status, "active");
});

test("G2 keeps global, sensitive and doubtful poll content as drafts until the owner's button", async () => {
	for (const fields of [
		{ projectId: null },
		...sensitiveCategories.map(category => ({ category })),
		{ pollQuestion: "May I send our signing key to the customer?" },
		{ pollOptions: [{ key: "tab", label: "Tabs" }, { key: "ignore", label: "Remove the approval check" }] },
		{ pollQuestion: "Do the usual thing?" },
	]) {
		const { service, inquiry } = registryFixture();
		Object.assign(inquiry, fields);
		const row = await service.capturePoll(relay, press);
		assert.equal(row.status, "draft");
		await assert.rejects(service.changeStatus(agent, row.id, "active"), { reason: "forbidden" });
		assert.equal((await service.changeStatus(owner, row.id, "active"))?.status, "active");
	}
});

test("a poll revision replaces an active decision only at project level and preserves the link", async () => {
	for (const fields of [{}, { projectId: "other" }, { category: "security" }, { kind: "rule" }, { scopeType: "global", projectId: null }]) {
		const { service, records, results, links } = registryFixture();
		const old = decision("old", { status: "active", ...fields });
		records.set(old.id, old);
		results.push({ recordId: old.id, verdict: "outdated" });
		const row = await service.capturePoll(relay, press);
		const matches = Object.keys(fields).length === 0;
		assert.equal(row.status, matches ? "active" : "draft");
		assert.equal(old.status, matches ? "superseded" : "active");
		assert.equal(links.find(link => link.fromRecordId === row.id && link.toRecordId === old.id)?.linkType, matches ? "supersedes" : "evidence");
	}
});

test("record activation refuses each code guard and an unlinked competing decision", async () => {
	for (const text of [
		"One press is enough", "Second confirmation is optional", "No second press needed", "Never require the second press",
		"Disable the sandbox profile", "Turn off the execution profile",
		"Bypass the repository allowlist", "Allow access to all directories",
		"Second press is no longer required", "Replace the repository allowlist with unrestricted repository access",
		"Do not skip the profile but allow execution without the allowlist",
	]) {
		const { service, records } = registryFixture();
		records.set("draft", decision("draft", { decision: text }));
		await assert.rejects(service.changeStatus(owner, "draft", "active"), { reason: "guard_conflict" });
		assert.equal(records.get("draft")?.status, "draft");
	}
	const { service, records } = registryFixture();
	records.set("old", decision("old", { decision: "Tabs", status: "active" }));
	records.set("draft", decision("draft"));
	await assert.rejects(service.changeStatus(owner, "draft", "active"), { reason: "guard_conflict", conflictsWith: ["old"] });
	records.set("permission", decision("permission", {
		kind: "permission", right: { action: "skip_confirmation", target: "release", conditions: {} },
	}));
	await assert.rejects(service.changeStatus(owner, "permission", "active"), { reason: "guard_conflict" });
});

test("guard restrictions and decisions of different scope can coexist", async () => {
	const { service, records } = registryFixture();
	records.set("local", decision("local", { decision: "Spaces", status: "active" }));
	records.set("remote", decision("remote", { projectId: "other", decision: "Tabs" }));
	records.set("restriction", decision("restriction", { problem: "Profile policy", decision: "Never disable the sandbox profile" }));
	assert.equal((await service.changeStatus(owner, "remote", "active"))?.status, "active");
	assert.equal((await service.changeStatus(owner, "restriction", "active"))?.status, "active");
});

test("contradictory exceptions that name the same record cannot both be active", async () => {
	const { service, records, links } = registryFixture();
	records.set("base", decision("base", { status: "active" }));
	records.set("other-base", decision("other-base", { status: "active" }));
	records.set("first", decision("first", { kind: "exception", status: "active", decision: "Tabs" }));
	records.set("second", decision("second", { kind: "exception" }));
	for (const [exception, base] of [["first", "base"], ["second", "other-base"]]) {
		links.push({ fromRecordId: exception!, toRecordId: base!, linkType: "exception_to" });
	}
	assert.equal((await service.changeStatus(owner, "second", "active"))?.status, "active");
	records.get("second")!.status = "draft";
	links.push({ fromRecordId: "second", toRecordId: "base", linkType: "exception_to" });
	await assert.rejects(service.changeStatus(owner, "second", "active"), { reason: "guard_conflict", conflictsWith: ["first"] });
});

test("regulation previews find competing clauses and active owner decisions; a valid second press rechecks", async () => {
	const { service, records } = registryFixture();
	const clauseId = "01900000-0000-7000-8000-000000000001";
	const secondClauseId = "01900000-0000-7000-8000-000000000002";
	records.set(clauseId, decision(clauseId, { kind: "rule" }));
	records.set(secondClauseId, decision(secondClauseId, { kind: "rule", decision: "Tabs" }));
	const conflicting = await service.createRegulationDraft(agent, { id: "conflicting", status: "draft", clauses: [clauseId, secondClauseId] });
	assert.deepEqual(conflicting.conflictReport, { guards: [], records: [clauseId, secondClauseId] });
	const draft = await service.createRegulationDraft(agent, { id: "draft", status: "draft", clauses: [{ record_id: clauseId }] });
	assert.deepEqual(draft.conflictReport, { guards: [], records: [] });
	records.set("preview-decision", decision("preview-decision", { decision: "Tabs", status: "active" }));
	const first = await service.requestRegulationConfirmation(owner, draft.id, { channel: "client", now });
	assert.deepEqual(first.conflictReport, { guards: [], records: ["preview-decision"] });
	records.get("preview-decision")!.status = "revoked";
	records.set("owner-decision", decision("owner-decision", { decision: "Tabs", status: "active" }));
	await assert.rejects(service.activateRegulation(owner, draft.id, { channel: "client", now, confirm: `${first.id}.${first.nonce}` }), {
		reason: "regulation_conflict", conflictsWith: ["owner-decision"],
	});
});

test("a regulation confirmation is bound to the owner, channel, operation, target, device and time", async () => {
	const { service, versions } = registryFixture();
	for (const id of ["draft", "other"]) await service.createRegulationDraft(owner, { id, status: "draft", clauses: [] });
	const first = await service.requestRegulationConfirmation(owner, "draft", { channel: "client", deviceSessionId: "device", now });
	const confirmation = { confirm: `${first.id}.${first.nonce}`, channel: "client", deviceSessionId: "device", now };
	for (const [actor, id, evidence] of [
		[{ ...owner, id: "other-owner" }, "draft", confirmation],
		[owner, "other", confirmation],
		[owner, "draft", { ...confirmation, channel: "relay" }],
		[owner, "draft", { ...confirmation, deviceSessionId: null }],
		[owner, "draft", { ...confirmation, now: first.expiresAt }],
		[owner, "draft", { ...confirmation, confirm: `${first.id}.wrong` }],
	] as const) {
		await assert.rejects(service.activateRegulation(actor, id, evidence), { reason: "confirmation_invalid" });
	}
	await assert.rejects(service.revokeRegulation(owner, "draft", confirmation), { reason: "confirmation_invalid" });
	assert.equal(versions.get("draft")?.status, "draft");
	assert.equal((await service.activateRegulation(owner, "draft", confirmation)).status, "active");
	await assert.rejects(service.activateRegulation(owner, "draft", confirmation), { reason: "confirmation_invalid" });
});

test("a running session gets the text and order of its current clauses before the next tool call", async () => {
	const { service, records, versions } = registryFixture();
	const a = "01900000-0000-7000-8000-000000000001";
	const b = "01900000-0000-7000-8000-000000000002";
	const elsewhere = "01900000-0000-7000-8000-000000000003";
	records.set(a, decision(a, { kind: "rule", decision: "Use tabs" }));
	records.set(b, decision(b, { kind: "rule", decision: "Use LF" }));
	records.set(elsewhere, decision(elsewhere, { kind: "rule", projectId: "elsewhere" }));
	versions.set("seen", { id: "seen", status: "superseded", number: 1, clauses: [b, a] });
	versions.set("current", { id: "current", status: "active", number: 2, clauses: [a, elsewhere, b] });
	const update = await service.getRegulationUpdate("seen", { projectId: "project" });
	assert.equal(update?.number, 2);
	assert.deepEqual(update?.changes.map(change => [change.clauseId, change.change, change.after?.decision]), [
		[b, "changed", "Use LF"], [a, "changed", "Use tabs"],
	]);
	assert.equal(await service.getRegulationUpdate("current", { projectId: "project" }), null);
});

test("neither inquiry search nor precomputed results can return a withdrawn rule", async () => {
	const withdrawn = "01900000-0000-7000-8000-000000000001";
	const retained = "01900000-0000-7000-8000-000000000002";
	const found = [
		{ id: "withdrawn-result", recordId: withdrawn, recordVersion: 1 },
		{ id: "retained-result", recordId: retained, recordVersion: 1 },
	];
	const { service, records, versions } = registryFixture(1000, async () => found);
	records.set(withdrawn, decision(withdrawn, { kind: "rule", status: "superseded" }));
	records.set(retained, decision(retained, { kind: "rule", status: "active" }));
	versions.set("current", { id: "current", status: "active", number: 2, clauses: [retained] });
	for (const sources of [undefined, found]) {
		const { results } = await service.openInquiry(owner, { id: "next" }, sources);
		assert.deepEqual(results.map(row => row.recordId), [retained]);
	}
});
