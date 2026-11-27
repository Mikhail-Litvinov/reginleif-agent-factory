import { randomUUID } from "node:crypto";
import { RegistryPoll } from "../contracts/schemas/requests.ts";
import type { Repo } from "../db/repo/index.ts";
import { RegistryRefusedError } from "../db/repo/registry.ts";
import { guardConflicts, harmlessPoll, isSensitive, ownerAuthority, recordConflicts, scopeKeys as keys } from "./policy.ts";
import { RegistryConflictError, regulationClauseIds, regulationService, type RegulationAssessment } from "./regulation.ts";

export { sensitiveCategories } from "./policy.ts";
export { RegistryConflictError } from "./regulation.ts";

type R = Repo["registry"];
type InquiryInput = Parameters<R["inquiries"]["create"]>[0];
type RecordInput = Parameters<R["records"]["create"]>[0];
type FoundResult = Omit<Parameters<R["results"]["create"]>[0], "inquiryId">;
type InquirySearch = (input: InquiryInput, registry: R) => Promise<FoundResult[]>;
type Actor = { type: "owner" | "agent"; id: string; tokenId?: string; runId?: string; sessionRef?: string; channel?: "telegram"; pressId?: string };
type Relay = { type: "owner" | "agent" | "relay" };
type PollPress = { pollId: string; pressId: string; telegramUserId: bigint | number; optionIndex: number; now?: Date };
type PollOption = (typeof RegistryPoll.shape.options)["_output"][number];
type Scoped = { id: string; kind: string | null; authority: string | null; status: string | null; scopeType: string | null; projectId: string | null; repository: string | null; machineId: string | null; action: string | null; target: string | null; reuse: string | null; statusChangedBy?: unknown };
type Scope = { projectId?: string | null; repository?: string | null; machineId?: string | null; action?: string | null; target?: string | null };
type Link = { fromRecordId: string | null; toRecordId: string | null; linkType: string | null };
export function applicableRecords<T extends Scoped>(rows: T[], scope: Scope): T[] {
	return rows.filter(r => r.status === "active" && r.reuse === "standing" && (r.scopeType === "global" || (r.scopeType === "project" && r.projectId != null && r.projectId === scope.projectId)) && keys.every(k => r[k] == null || r[k] === scope[k]));
}
export function compareAuthority(a: Scoped, b: Scoped, links: Link[]): number {
	const excepts = (x: Scoped, y: Scoped) => x.kind === "exception" && links.some(l => l.linkType === "exception_to" && l.fromRecordId === x.id && l.toRecordId === y.id);
	if (excepts(a,b)) return 1;
	if (excepts(b,a)) return -1;
	const rank = (x: Scoped) => x.kind === "rule" ? 3 : ownerAuthority(x) && (x.kind === "decision" || x.kind === "exception") ? 2 : x.kind === "precedent" ? 1 : 0;
	const delta = rank(a) - rank(b);
	if (delta) return Math.sign(delta);
	if (a.kind === "exception" || b.kind === "exception") return 0;
	const narrower = (x: Scoped, y: Scoped) => (x.scopeType === y.scopeType || (x.scopeType === "project" && y.scopeType === "global")) && keys.every(k => y[k] == null || x[k] === y[k]) && (x.scopeType !== y.scopeType || keys.some(k => x[k] != null && y[k] == null));
	return narrower(a,b) ? 1 : narrower(b,a) ? -1 : 0;
}
const refuse = (reason: string): never => { throw new RegistryRefusedError(reason); };
const owner = (a: Actor) => { if (a.type !== "owner") refuse("forbidden"); };
const relay = (a: Relay) => { if (a.type !== "relay") refuse("forbidden"); };
const bound = (a: Actor, i: { tokenId?: string | null; runId?: string | null; sessionRef?: string | null }) => a.type === "owner" || (a.tokenId != null && a.tokenId === i.tokenId && (a.runId ?? null) === (i.runId ?? null) && (a.sessionRef ?? null) === (i.sessionRef ?? null));
const validateRecord = (actor: Actor, input: RecordInput) => {
	if (!((input.scopeType === "global" && input.projectId == null) || (input.scopeType === "project" && input.projectId != null))) refuse("registry_scope_required");
	if (input.kind === "permission" && input.source === "poll_press") refuse("permission_by_poll");
	if (input.status !== "draft" || input.authority !== actor.type || (actor.type === "agent" && input.kind === "permission")) refuse("forbidden");
	if (input.source === "poll_press" || input.pressId != null || input.pollOption != null || input.pressedOption != null || input.statusChangedBy != null) refuse("forbidden");
	if (actor.type === "agent" && ["owner_button", "owner_message", "orchestrator"].includes(input.source ?? "")) refuse("forbidden");
	if (actor.type === "owner" && (input.kind === "precedent" || input.kind === "fact")) refuse("forbidden");
	if ((input.kind === "fact" || input.kind === "precedent") && (typeof input.evidence !== "object" || input.evidence === null || Object.keys(input.evidence).length === 0)) refuse("evidence_missing");
};

async function replacementCandidates(registry: R, inquiryId: string, input: RecordInput) {
	const results = await registry.results.forInquiry(inquiryId);
	const outdated = new Set<string>();
	const conflicts = new Set<string>();
	const replacements = [];
	for (const result of results) {
		if (result.verdict === "conflict") {
			if (result.recordId) conflicts.add(result.recordId);
			if (result.conflictsWithId) conflicts.add(result.conflictsWithId);
		}
		if (result.verdict !== "outdated" || !result.recordId) continue;
		outdated.add(result.recordId);
		const row = await registry.records.get(result.recordId);
		if (row?.status === "active" && row.kind === "decision" && row.scopeType === "project" && row.projectId === input.projectId &&
			ownerAuthority(row) && !isSensitive(row.category) && keys.every(key => (row[key] ?? null) === (input[key] ?? null))) {
			replacements.push(row.id);
		}
	}
	return { outdated, conflicts, replacements };
}

export function createRegistryService(repo: Repo, search?: InquirySearch, assessRegulation?: RegulationAssessment) {
	return {
		...regulationService(repo, assessRegulation),
		async registerPoll(actor: Relay, id: string, poll: { question: string; options: PollOption[]; now?: Date }) {
			relay(actor);
			const options = RegistryPoll.shape.options.safeParse(poll.options);
			if (!poll.question.trim() || !options.success || !options.data.length || options.data.some(option => !option.label.trim())) {
				return refuse("validation_failed");
			}
			return repo.transaction(async tx => {
				if (!await tx.registry.inquiries.get(id)) return refuse("not_found");
				const inquiry = await tx.registry.inquiries.registerPoll(id, {
					pollQuestion: poll.question, pollOptions: options.data, pollRegisteredAt: poll.now ?? new Date(),
				});
				if (!inquiry) return refuse("validation_failed");
				const reuse = inquiry.reuseIntent ?? "once";
				const displayLine = `will be recorded: ${inquiry.category ?? ""}, ${inquiry.projectId ?? "global"}, ${reuse}`;
				return { pollId: inquiry.id, displayLine };
			});
		},
		async capturePoll(actor: Relay, input: PollPress) {
			relay(actor);
			if (!input.pressId.trim() || !Number.isSafeInteger(input.optionIndex) || input.optionIndex < 0 ||
				(typeof input.telegramUserId === "number" && !Number.isSafeInteger(input.telegramUserId))) return refuse("validation_failed");
			return repo.transaction(async tx => {
				const ownerRow = await tx.owners.byTelegramUserId(BigInt(input.telegramUserId));
				if (!ownerRow) return refuse("forbidden");
				const { registry } = tx;
				await registry.lock();
				if (await registry.records.captureByPress(input.pressId)) return refuse("press_replayed");
				const inquiry = await registry.inquiries.get(input.pollId);
				if (!inquiry?.pollRegisteredAt || !inquiry.pollQuestion) return refuse("not_found");
				if (await registry.records.captureByInquiry(inquiry.id)) return refuse("poll_closed");
				const options = RegistryPoll.shape.options.safeParse(inquiry.pollOptions);
				const option = options.success && options.data[input.optionIndex];
				if (!option) return refuse("validation_failed");
				const createdBy = { type: "owner", id: ownerRow.id };
				const candidate: RecordInput = {
					id: randomUUID(), kind: "decision", authority: "owner", scopeType: inquiry.projectId ? "project" : "global",
					projectId: inquiry.projectId, action: inquiry.action, target: inquiry.target, category: inquiry.category,
					problem: inquiry.pollQuestion, question: inquiry.pollQuestion, options: inquiry.pollOptions,
					decision: option.label, pressedOption: option.label, reuse: inquiry.reuseIntent ?? "once",
					source: "poll_press", sourceRef: input.pressId, pressId: input.pressId, pollOption: input.optionIndex,
					inquiryId: inquiry.id, runId: inquiry.runId, createdBy,
				};
				const { outdated, conflicts, replacements } = await replacementCandidates(registry, inquiry.id, candidate);
				const harmless = harmlessPoll(inquiry.category, inquiry.pollQuestion, options.data.map(entry => entry.label));
				const active = Boolean(inquiry.projectId) && inquiry.action == null && inquiry.target == null && harmless &&
					conflicts.size === 0 && outdated.size === replacements.length && guardConflicts(candidate).length === 0 &&
					(await recordConflicts(registry, candidate, [], replacements)).length === 0;
				const now = input.now ?? new Date();
				const row = await registry.records.create({ ...candidate, status: "draft" });
				for (const id of outdated) {
					await registry.links.create({
						id: randomUUID(), fromRecordId: row.id, toRecordId: id,
						linkType: replacements.includes(id) ? "supersedes" : "evidence", createdBy,
					});
				}
				for (const id of conflicts) {
					await registry.links.create({ id: randomUUID(), fromRecordId: row.id, toRecordId: id, linkType: "conflicts_with", createdBy });
				}
				if (!active) return row;
				const activated = await registry.records.changeStatus(row.id, "active", now, createdBy);
				for (const id of replacements) await registry.records.changeStatus(id, "superseded", now, createdBy);
				return activated ?? refuse("not_found");
			});
		},
		async createRecord(actor: Actor, input: Parameters<R["records"]["create"]>[0]) {
			validateRecord(actor, input);
			return repo.registry.records.create({ ...input, createdBy: actor });
		},
		async createSupersedingDraft(actor: Actor, oldId: string, linkId: string, input: Parameters<R["records"]["create"]>[0]) {
			owner(actor);
			validateRecord(actor, input);
			return repo.transaction(async tx => {
				if (!await tx.registry.records.get(oldId)) return refuse("not_found");
				const record = await tx.registry.records.create({ ...input, createdBy: actor });
				await tx.registry.links.create({ id: linkId, fromRecordId: record.id, toRecordId: oldId, linkType: "supersedes", createdBy: actor });
				return record;
			});
		},
		async linkRecords(actor: Actor, input: Parameters<R["links"]["create"]>[0]) {
			owner(actor);
			return repo.transaction(async tx => {
				await tx.registry.lock();
				const from = input.fromRecordId && await tx.registry.records.get(input.fromRecordId);
				const to = input.toRecordId && await tx.registry.records.get(input.toRecordId);
				if (!from || !to) return refuse("not_found");
				if (input.linkType === "supersedes" && from.status !== "draft") return refuse("validation_failed");
				return tx.registry.links.create({ ...input, createdBy: actor });
			});
		},
		async changeStatus(actor: Actor, id: string, status: "active" | "rejected" | "revoked" | "superseded", at?: Date) {
			owner(actor);
			if (status === "superseded") return refuse("validation_failed");
			return repo.transaction(async tx => {
				await tx.registry.lock();
				const record = await tx.registry.records.get(id);
				if (!record) return refuse("not_found");
				if ((status === "active" || record.status === "active") && record.kind === "rule") return refuse("rule_needs_regulation");
				if (record.status !== (status === "revoked" ? "active" : "draft")) return refuse("validation_failed");
				const now = at ?? new Date();
				if (status !== "active") return tx.registry.records.changeStatus(id, status, now, actor);
				const links = await tx.registry.links.forRecord(id);
				const conflicts = await recordConflicts(tx.registry, record, links);
				if (guardConflicts(record).length || conflicts.length) throw new RegistryConflictError("guard_conflict", conflicts);
				const replacements = [];
				for (const link of links) {
					if (link.fromRecordId !== id || link.linkType !== "supersedes" || !link.toRecordId) continue;
					const previous = await tx.registry.records.get(link.toRecordId);
					if (previous?.status !== "active") continue;
					if (previous.kind === "rule") return refuse("rule_needs_regulation");
					replacements.push(previous.id);
				}
				const changed = await tx.registry.records.changeStatus(id, status, now, actor);
				for (const previousId of replacements) await tx.registry.records.changeStatus(previousId, "superseded", now, actor);
				return changed;
			});
		},
		async openInquiry(actor: Actor, input: InquiryInput, results?: FoundResult[]) {
			if (!bound(actor,input)) refuse("forbidden");
			return repo.transaction(async tx => {
				await tx.registry.lock("read");
				const active = await tx.registry.regulations.active();
				const currentInput = {
					...input, regulationVersionId: active?.id ?? null, reuseIntent: input.reuseIntent ?? "once",
					pollQuestion: null, pollOptions: null, pollRegisteredAt: null,
				};
				const inquiry = await tx.registry.inquiries.create(currentInput);
				const found = results ?? (search ? await search(currentInput, tx.registry) : refuse("unavailable"));
				const activeClauses = regulationClauseIds(active?.clauses ?? []);
				const outsideRegulation = found.flatMap(result => {
					const id = result.recordId?.toLowerCase();
					return id && !activeClauses.has(id) ? [id] : [];
				});
				const withdrawn = new Set(outsideRegulation.length ? await tx.registry.records.ruleIds(outsideRegulation) : []);
				const attached = [];
				for (const r of found) {
					if (r.recordId && withdrawn.has(r.recordId.toLowerCase())) continue;
					attached.push(await tx.registry.results.create({ ...r, inquiryId: inquiry.id }));
				}
				return { inquiry, results: attached };
			});
		},
		async attachResults(id: string, results: Omit<Parameters<R["results"]["create"]>[0], "inquiryId">[]) {
			return repo.transaction(async tx => {
				if (!await tx.registry.inquiries.get(id)) return refuse("not_found");
				const attached = [];
				for (const r of results) attached.push(await tx.registry.results.create({ ...r, inquiryId: id }));
				return attached;
			});
		},
		async setVerdict(actor: Actor, id: string, recordId: string, verdict: { verdict: "applies" | "not_applicable" | "outdated" | "conflict"; difference?: string; conflictsWithId?: string }) {
			if (actor.type !== "agent") refuse("forbidden");
			return repo.transaction(async tx => {
				const inquiry = await tx.registry.inquiries.get(id);
				if (!inquiry) return refuse("not_found");
				if (!bound(actor,inquiry)) return refuse("forbidden");
				const results = await tx.registry.results.forInquiry(id), found = results.find(r => r.recordId === recordId);
				if (!found) return refuse("not_found");
				if ((verdict.verdict !== "applies" && !verdict.difference) || (verdict.verdict === "conflict" && !results.some(r => r.recordId === verdict.conflictsWithId))) return refuse("validation_failed");
				return await tx.registry.results.setVerdict(found.id, { ...verdict, verdictAt: new Date() }) ?? refuse("validation_failed");
			});
		},
	};
}
