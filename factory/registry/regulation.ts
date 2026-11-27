import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Repo } from "../db/repo/index.ts";
import { RegistryRefusedError } from "../db/repo/registry.ts";
import { regulationConflicts, scopeKeys, type ConflictReport } from "./policy.ts";

type Registry = Repo["registry"];
type Version = NonNullable<Awaited<ReturnType<Registry["regulations"]["get"]>>>;
type Draft = Parameters<Registry["regulations"]["create"]>[0];
type Actor = { type: "owner" | "agent"; id: string };
type ConfirmationContext = { channel: string; deviceSessionId?: string | null; now?: Date };
type Confirmation = ConfirmationContext & { confirm: string };
type Operation = "activate" | "revoke";
type Scope = Partial<Record<"projectId" | typeof scopeKeys[number], string | null>>;
export type RegulationAssessment = (version: Version, registry: Registry) => Promise<ConflictReport>;

export class RegistryConflictError extends RegistryRefusedError {
	readonly conflictsWith: string[];
	constructor(reason: "guard_conflict" | "regulation_conflict", conflictsWith: string[]) {
		super(reason);
		this.conflictsWith = conflictsWith;
	}
}

const refuse = (reason: string): never => { throw new RegistryRefusedError(reason); };
const owner = (actor: Actor) => { if (actor.type !== "owner") refuse("forbidden"); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function clauseEntries(clauses: unknown) {
	if (!Array.isArray(clauses)) return refuse("validation_failed");
	const entries = new Map<string, unknown>();
	for (const clause of clauses) {
		const id = typeof clause === "object" && clause !== null
			? Reflect.get(clause, "record_id") ?? Reflect.get(clause, "id") : clause;
		if (typeof id !== "string" || !uuid.test(id) || entries.has(id.toLowerCase())) return refuse("validation_failed");
		entries.set(id.toLowerCase(), clause);
	}
	return entries;
}

export const regulationClauseIds = (clauses: unknown) => new Set(clauseEntries(clauses).keys());

async function loadClauses(registry: Registry, entries: ReturnType<typeof clauseEntries>) {
	const records = [];
	for (const id of entries.keys()) {
		const row = await registry.records.get(id);
		if (!row || row.kind !== "rule" || (row.scopeType !== "global" && row.scopeType !== "project")) return refuse("validation_failed");
		records.push(row);
	}
	return records;
}

async function getVersion(registry: Registry, id: string) {
	return await registry.regulations.get(id) ?? refuse("not_found");
}

function binding(actor: Actor, id: string, operation: Operation, context: ConfirmationContext) {
	return {
		actorId: actor.id, channel: context.channel, deviceSessionId: context.deviceSessionId ?? null,
		operation: operation === "activate" ? "regulation_activate" : "regulation_revoke",
		targetType: "regulation_version", targetId: id,
		requestHash: hash(JSON.stringify(["POST", `/regulation/versions/${id}/${operation}`, {}])),
	};
}

async function consumeConfirmation(tx: Pick<Repo, "confirmations">, actor: Actor, id: string, operation: Operation, confirmation: Confirmation, now: Date) {
	const [confirmationId, nonce, ...rest] = confirmation.confirm.split(".");
	if (!confirmationId || !uuid.test(confirmationId) || !nonce || !/^[A-Za-z0-9_-]+$/u.test(nonce) || rest.length) {
		return refuse("confirmation_invalid");
	}
	const row = await tx.confirmations.get(confirmationId);
	const expected = row?.nonceHash;
	const actual = hash(nonce);
	if (!expected || !/^[0-9a-f]{64}$/u.test(expected) || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) {
		return refuse("confirmation_invalid");
	}
	if (!await tx.confirmations.consume({ ...binding(actor, id, operation, confirmation), id: confirmationId, now })) {
		return refuse("confirmation_invalid");
	}
	return confirmationId;
}

async function scopedClauses(registry: Registry, version: Version | undefined, scope?: Scope) {
	const clauses = clauseEntries(version?.clauses ?? []);
	const ordered = [];
	for (const row of await loadClauses(registry, clauses)) {
		if (scope && ((row.scopeType !== "global" && row.projectId !== scope.projectId) ||
			!scopeKeys.every(key => row[key] == null || row[key] === scope[key]))) continue;
		ordered.push([row.id, {
			position: ordered.length, clause: clauses.get(row.id), category: row.category,
			problem: row.problem, decision: row.decision, exceptionsText: row.exceptionsText,
		}] as const);
	}
	return new Map(ordered);
}

async function compareVersions(registry: Registry, from: Version | undefined, to: Version | undefined, scope?: Scope) {
	const before = await scopedClauses(registry, from, scope);
	const after = await scopedClauses(registry, to, scope);
	const changes = [];
	for (const [clauseId, value] of before) {
		if (!after.has(clauseId)) changes.push({ clauseId, change: "removed" as const, before: value, after: null });
		else if (!isDeepStrictEqual(value, after.get(clauseId))) {
			changes.push({ clauseId, change: "changed" as const, before: value, after: after.get(clauseId) });
		}
	}
	for (const [clauseId, value] of after) {
		if (!before.has(clauseId)) changes.push({ clauseId, change: "added" as const, before: null, after: value });
	}
	return { fromId: from?.id ?? null, toId: to?.id ?? null, changes };
}

export function regulationService(repo: Repo, extraAssessment?: RegulationAssessment) {
	// The status trigger retains the immutable activation metadata. Record the second press that ended a version.
	async function auditEnd(tx: Pick<Repo, "audit">, actor: Actor, versionId: string, confirmationId: string, status: "revoked" | "superseded") {
		await tx.audit.append({
			id: randomUUID(), actorId: actor.id, action: status === "revoked" ? "regulation.revoke" : "regulation.supersede",
			targetType: "regulation_versions", targetId: versionId, outcome: "ok",
			details: { confirmation_id: confirmationId, old_status: "active", new_status: status },
		});
	}

	async function assess(registry: Registry, version: Version): Promise<ConflictReport> {
		const clauses = await loadClauses(registry, clauseEntries(version.clauses));
		if (clauses.some(row => row.status !== "draft" && row.status !== "active")) return refuse("validation_failed");
		const report = await regulationConflicts(registry, clauses);
		if (!extraAssessment) return report;
		const extra = await extraAssessment(version, registry);
		return {
			guards: [...new Set([...report.guards, ...extra.guards])].sort(),
			records: [...new Set([...report.records, ...extra.records])].sort(),
		};
	}

	async function changeRegulation(actor: Actor, id: string, operation: Operation, confirmation?: Confirmation) {
		owner(actor);
		if (!confirmation) return refuse("confirmation_required");
		return repo.transaction(async tx => {
			await tx.registry.lock();
			const now = confirmation.now ?? new Date();
			const confirmationId = await consumeConfirmation(tx, actor, id, operation, confirmation, now);
			const version = await getVersion(tx.registry, id);
			if (operation === "revoke") {
				if (version.status !== "active") return refuse("validation_failed");
				const revoked = await tx.registry.regulations.changeStatus(id, { status: "revoked", statusChangedAt: now }) ?? refuse("not_found");
				await auditEnd(tx, actor, id, confirmationId, "revoked");
				return revoked;
			}
			if (version.status !== "draft") return refuse("validation_failed");
			const maxBytes = (await tx.settings.snapshot(["registry.clauseMaxBytes"]))["registry.clauseMaxBytes"];
			if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return refuse("unavailable");
			if (Math.max(Buffer.byteLength(JSON.stringify(version.clauses)), version.clausesBytes ?? 0) > maxBytes) {
				return refuse("regulation_too_large");
			}
			const report = await assess(tx.registry, version);
			if (report.guards.length) throw new RegistryConflictError("guard_conflict", report.records);
			if (report.records.length) throw new RegistryConflictError("regulation_conflict", report.records);
			const previous = await tx.registry.regulations.active();
			const activated = await tx.registry.regulations.changeStatus(id, {
				status: "active", statusChangedAt: now, activatedAt: now, confirmedBy: actor.id, confirmationId, conflictReport: report,
			}) ?? refuse("not_found");
			if (previous) await auditEnd(tx, actor, previous.id, confirmationId, "superseded");
			return activated;
		});
	}

	return {
		async createRegulationDraft(actor: Actor, input: Draft) {
			if (input.status !== undefined && input.status !== "draft") return refuse("forbidden");
			clauseEntries(input.clauses);
			return repo.transaction(async tx => {
				await tx.registry.lock();
				const draft = await tx.registry.regulations.create({
					id: input.id, status: "draft", number: await tx.registry.regulations.nextNumber(),
					clauses: input.clauses, clausesBytes: Buffer.byteLength(JSON.stringify(input.clauses)),
					basisVersionId: input.basisVersionId, proposedBy: { type: actor.type, id: actor.id },
				});
				// The preview is transient. The immutable audit metadata is assigned at the second press.
				return { ...draft, conflictReport: await assess(tx.registry, draft) };
			});
		},
		async requestRegulationConfirmation(actor: Actor, id: string, context: ConfirmationContext, operation: Operation = "activate") {
			owner(actor);
			return repo.transaction(async tx => {
				await tx.registry.lock("read");
				const version = await getVersion(tx.registry, id);
				if (version.status !== (operation === "activate" ? "draft" : "active")) return refuse("validation_failed");
				const seconds = (await tx.settings.snapshot(["confirm.windowSeconds"]))["confirm.windowSeconds"];
				if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return refuse("unavailable");
				const conflictReport = operation === "activate" ? await assess(tx.registry, version) : null;
				const now = context.now ?? new Date();
				const expiresAt = new Date(now.getTime() + seconds * 1000);
				const confirmationId = randomUUID();
				const nonce = randomBytes(32).toString("base64url");
				await tx.confirmations.create({
					...binding(actor, id, operation, context), id: confirmationId, nonceHash: hash(nonce), issuedAt: now, expiresAt,
				});
				return { id: confirmationId, nonce, expiresAt, conflictReport };
			});
		},
		activateRegulation: (actor: Actor, id: string, confirmation?: Confirmation) => changeRegulation(actor, id, "activate", confirmation),
		revokeRegulation: (actor: Actor, id: string, confirmation?: Confirmation) => changeRegulation(actor, id, "revoke", confirmation),
		async getRegulationDiff(id: string, scope?: Scope) {
			return repo.transaction(async tx => {
				await tx.registry.lock("read");
				const version = await getVersion(tx.registry, id);
				return compareVersions(tx.registry, await tx.registry.regulations.active(), version, scope);
			});
		},
		async getRegulationUpdate(seenId: string | null, scope: Scope) {
			return repo.transaction(async tx => {
				await tx.registry.lock("read");
				const active = await tx.registry.regulations.active();
				if ((active?.id ?? null) === seenId) return null;
				const seen = seenId === null ? undefined : await getVersion(tx.registry, seenId);
				const diff = await compareVersions(tx.registry, seen, active, scope);
				return { ...diff, number: active?.number ?? null };
			});
		},
	};
}
