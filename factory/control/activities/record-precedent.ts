import { createHash } from "node:crypto";
import type { Repo } from "../../db/repo/index.ts";
import type { createRegistryService } from "../../registry/service.ts";

type Service = Pick<ReturnType<typeof createRegistryService>, "createRecord">;
type Registry = Pick<Repo["registry"]["records"], "get">;

/** The three moments temporal.md names for a precedent: a settled dispute, a resolved block, an answered question. */
export const precedentCases = ["dispute", "block", "question"] as const;
export type PrecedentCase = (typeof precedentCases)[number];

export interface RecordPrecedentInput {
	readonly taskId: string;
	readonly runId: string;
	readonly case: PrecedentCase;
	// An agent writes only advice: a precedent, or a fact kept as a draft. Never a rule, a decision or an exception.
	readonly kind?: "precedent" | "fact";
	readonly scope: { readonly type: "global" } | { readonly type: "project"; readonly projectId: string };
	readonly problem: string;
	readonly decision: string;
	readonly grounds?: string;
	readonly consequences?: string;
	readonly category?: string;
	readonly summary?: string;
	readonly inquiryId?: string;
	// What the outcome rests on (links, ids). The idempotency key is added to it, so the evidence is never empty.
	readonly evidence?: Record<string, unknown>;
}

/** Idempotency key of the activity: task id + run id + case (temporal.md activity table). */
export const precedentKey = (input: Pick<RecordPrecedentInput, "taskId" | "runId" | "case">): string =>
	`${input.taskId}:${input.runId}:${input.case}`;

// The record id is derived from the key, so a repeated attempt addresses the same row and a lost write is repeated by its key.
export const precedentId = (key: string): string => {
	const hex = createHash("sha256").update(`record-precedent|${key}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Writes advice from a settled case through RegistryService (registry-authority): the actor is an agent, the status is
 * draft, the source is agent_proposal. The service refuses any owner-authority or active record, so the activity cannot
 * produce one. A precedent never outranks a rule or an owner decision; it only becomes advice after the owner or the
 * orchestrator activates it elsewhere.
 */
export const createRecordPrecedent = (deps: { readonly service: Service; readonly records: Registry }) =>
	async (input: RecordPrecedentInput) => {
		if (!precedentCases.includes(input.case)) throw new RangeError(`unknown precedent case: ${String(input.case)}`);
		const key = precedentKey(input);
		const id = precedentId(key);
		const existing = await deps.records.get(id);
		if (existing) return existing;
		try {
			return await deps.service.createRecord({ type: "agent", id: input.runId, runId: input.runId }, {
				id, kind: input.kind ?? "precedent", authority: "agent", status: "draft",
				scopeType: input.scope.type, projectId: input.scope.type === "project" ? input.scope.projectId : null,
				category: input.category ?? null, problem: input.problem, decision: input.decision,
				grounds: input.grounds ?? null, consequences: input.consequences ?? null, summary: input.summary ?? null,
				reuse: "standing", source: "agent_proposal", sourceRef: key, runId: input.runId, inquiryId: input.inquiryId ?? null,
				evidence: { ...input.evidence, idempotencyKey: key, taskId: input.taskId, runId: input.runId, case: input.case },
			});
		} catch (error) {
			// A concurrent attempt with the same key may have won the insert; the row it wrote is the answer.
			const written = await deps.records.get(id);
			if (written) return written;
			throw error;
		}
	};
