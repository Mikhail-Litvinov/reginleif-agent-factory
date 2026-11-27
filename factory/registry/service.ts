import type { Repo } from "../db/repo/index.ts";
import { RegistryRefusedError } from "../db/repo/registry.ts";
type R = Repo["registry"];
type InquiryInput = Parameters<R["inquiries"]["create"]>[0];
type FoundResult = Omit<Parameters<R["results"]["create"]>[0], "inquiryId">;
type InquirySearch = (input: InquiryInput, registry: R) => Promise<FoundResult[]>;
type Actor = { type: "owner" | "agent"; id: string; tokenId?: string; runId?: string; sessionRef?: string };
type Scoped = { id: string; kind: string | null; authority: string | null; status: string | null; scopeType: string | null; projectId: string | null; repository: string | null; machineId: string | null; action: string | null; target: string | null; reuse: string | null };
type Scope = { projectId?: string | null; repository?: string | null; machineId?: string | null; action?: string | null; target?: string | null };
type Link = { fromRecordId: string | null; toRecordId: string | null; linkType: string | null };
const keys = ["repository", "machineId", "action", "target"] as const;
export function applicableRecords<T extends Scoped>(rows: T[], scope: Scope): T[] {
	return rows.filter(r => r.status === "active" && r.reuse === "standing" && (r.scopeType === "global" || (r.scopeType === "project" && r.projectId != null && r.projectId === scope.projectId)) && keys.every(k => r[k] == null || r[k] === scope[k]));
}
export function compareAuthority(a: Scoped, b: Scoped, links: Link[]): number {
	const excepts = (x: Scoped, y: Scoped) => x.kind === "exception" && links.some(l => l.linkType === "exception_to" && l.fromRecordId === x.id && l.toRecordId === y.id);
	if (excepts(a,b)) return 1;
	if (excepts(b,a)) return -1;
	const rank = (x: Scoped) => x.kind === "rule" ? 3 : x.authority === "owner" && (x.kind === "decision" || x.kind === "exception") ? 2 : x.kind === "precedent" ? 1 : 0;
	const delta = rank(a) - rank(b);
	if (delta) return Math.sign(delta);
	if (a.kind === "exception" || b.kind === "exception") return 0;
	const narrower = (x: Scoped, y: Scoped) => (x.scopeType === y.scopeType || (x.scopeType === "project" && y.scopeType === "global")) && keys.every(k => y[k] == null || x[k] === y[k]) && (x.scopeType !== y.scopeType || keys.some(k => x[k] != null && y[k] == null));
	return narrower(a,b) ? 1 : narrower(b,a) ? -1 : 0;
}
const refuse = (reason: string): never => { throw new RegistryRefusedError(reason); };
const owner = (a: Actor) => { if (a.type !== "owner") refuse("forbidden"); };
const bound = (a: Actor, i: { tokenId?: string | null; runId?: string | null; sessionRef?: string | null }) => a.type === "owner" || (a.tokenId != null && a.tokenId === i.tokenId && (a.runId ?? null) === (i.runId ?? null) && (a.sessionRef ?? null) === (i.sessionRef ?? null));
const validateRecord = (actor: Actor, input: Parameters<R["records"]["create"]>[0]) => {
	if (!((input.scopeType === "global" && input.projectId == null) || (input.scopeType === "project" && input.projectId != null))) refuse("registry_scope_required");
	if (input.kind === "permission" && input.source === "poll_press") refuse("permission_by_poll");
	if (input.status !== "draft" || input.authority !== actor.type || (actor.type === "agent" && input.kind === "permission")) refuse("forbidden");
	if (actor.type === "agent" && ["owner_button", "owner_message", "poll_press", "orchestrator"].includes(input.source ?? "")) refuse("forbidden");
	if (actor.type === "owner" && (input.kind === "precedent" || input.kind === "fact")) refuse("forbidden");
	if ((input.kind === "fact" || input.kind === "precedent") && (typeof input.evidence !== "object" || input.evidence === null || Object.keys(input.evidence).length === 0)) refuse("evidence_missing");
};
export function createRegistryService(repo: Repo, search?: InquirySearch) {
	return {
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
				const from = input.fromRecordId && await tx.registry.records.get(input.fromRecordId);
				const to = input.toRecordId && await tx.registry.records.get(input.toRecordId);
				if (!from || !to) return refuse("not_found");
				if (input.linkType === "supersedes" && from.status !== "draft") return refuse("validation_failed");
				return tx.registry.links.create({ ...input, createdBy: actor });
			});
		},
		async changeStatus(actor: Actor, id: string, status: "active" | "rejected" | "revoked" | "superseded") {
			owner(actor);
			return repo.transaction(async tx => {
				const record = await tx.registry.records.get(id);
				if (!record) return refuse("not_found");
				if (status === "active" && record.kind === "rule") return refuse("rule_needs_regulation");
				const changed = await tx.registry.records.changeStatus(id,status,new Date(),actor);
				if (status === "active") for (const l of await tx.registry.links.forRecord(id)) if (l.fromRecordId === id && l.linkType === "supersedes" && l.toRecordId) await tx.registry.records.changeStatus(l.toRecordId,"superseded",new Date(),actor);
				return changed;
			});
		},
		async openInquiry(actor: Actor, input: InquiryInput, results?: FoundResult[]) {
			if (!bound(actor,input)) refuse("forbidden");
			return repo.transaction(async tx => {
				const inquiry = await tx.registry.inquiries.create({ ...input, reuseIntent: input.reuseIntent ?? "once" });
				const found = results ?? (search ? await search(input, tx.registry) : refuse("unavailable"));
				const attached = [];
				for (const r of found) attached.push(await tx.registry.results.create({ ...r, inquiryId: inquiry.id }));
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
