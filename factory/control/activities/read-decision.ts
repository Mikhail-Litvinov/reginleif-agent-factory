import type { Repo } from "../../db/repo/index.ts";
import { DecisionNotFoundError, type RefusalCode } from "./refusal.ts";

export interface ReadDecisionInput {
	decisionId: string;
}

export interface ReadDecisionResult {
	decisionId: string;
	// The columns are nullable in the schema type; the physical check keeps them set on real rows.
	taskId: string | null;
	kind: string | null;
	deliveryState: string | null;
	taskStatus: string | null;
	currentRevision: number | null;
	// The first refusal the handler's checks find, or null when the decision may be applied.
	refusal: RefusalCode | null;
}

// Kinds that carry the revision the deciding actor saw (temporal.md: approve, reject, request_changes, resolve_block,
// revise_requirements).
const revisionKinds: ReadonlySet<string> = new Set(["approve", "reject", "request_changes", "resolve_block", "revise_requirements"]);
// States in which a kind applies at all among the kinds with one fixed state (decision matrix in temporal.md).
const onlyIn: Readonly<Record<string, string>> = { approve: "AWAITING_APPROVAL", reject: "AWAITING_APPROVAL", request_changes: "AWAITING_APPROVAL", resolve_block: "BLOCKED" };
const finalStates: ReadonlySet<string> = new Set(["ACCEPTED", "REJECTED", "CANCELLED", "FAILED"]);
// PAUSED: only these apply, everything else is refused not_allowed_in_state (D22).
const pausedAllows: ReadonlySet<string> = new Set(["resume", "cancel", "add_feedback", "revise_requirements"]);

// Pure read: it changes nothing, so a replay returns the same answer while the rows are unchanged.
export const ReadDecision = async (repo: Pick<Repo, "decisions" | "tasks" | "owners">, input: ReadDecisionInput): Promise<ReadDecisionResult> => {
	const decision = await repo.decisions.get(input.decisionId);
	if (!decision) throw new DecisionNotFoundError(input.decisionId);
	const task = decision.taskId === null ? undefined : await repo.tasks.get(decision.taskId, { includeDeleted: true });
	const kind = decision.kind ?? "";
	const base = { decisionId: decision.id, taskId: decision.taskId, kind: decision.kind, deliveryState: decision.deliveryState, taskStatus: task?.status ?? null, currentRevision: task?.currentRevision ?? null };
	const refuse = (refusal: RefusalCode): ReadDecisionResult => ({ ...base, refusal });
	if (decision.deliveryState === "applied" || decision.deliveryState === "refused") return refuse("already_resolved");
	if (!task) return refuse("task_closed");

	// Actor: an owner must be active; the chief engineer may only resolve a block that it handles.
	if (decision.actorId !== null) {
		if (!(await repo.owners.activeById(decision.actorId))) return refuse("actor_not_allowed");
	} else if (kind !== "resolve_block") return refuse("actor_not_allowed");
	else if (task.blockHandler !== "chief_engineer") return refuse("block_handled");

	if (finalStates.has(task.status ?? "")) return refuse("task_closed");
	const required = onlyIn[kind];
	if (required !== undefined && task.status !== required) return refuse("not_allowed_in_state");
	if (task.status === "PAUSED" && !pausedAllows.has(kind)) return refuse("not_allowed_in_state");
	if (kind === "resolve_block") {
		const payload = decision.payload as { block_kind?: unknown } | null;
		if (typeof payload?.block_kind === "string" && payload.block_kind !== task.blockKind) return refuse("block_kind_mismatch");
	}
	if (revisionKinds.has(kind) && decision.revisionNumber !== task.currentRevision) return refuse("revision_stale");
	return { ...base, refusal: null };
};
