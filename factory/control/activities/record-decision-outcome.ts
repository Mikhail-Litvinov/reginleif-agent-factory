import type { Repo } from "../../db/repo/index.ts";
import { DecisionNotFoundError, isRefusalCode } from "./refusal.ts";

export interface RecordDecisionOutcomeInput {
	decisionId: string;
	outcome: "applied" | "refused";
	// Required with `refused` (one of the refusal codes), forbidden with `applied`.
	refusalReason?: string;
}

export interface RecordDecisionOutcomeResult {
	decisionId: string;
	deliveryState: string | null;
	refusalReason: string | null;
	// True when the decision was already resolved: the first outcome stays and nothing was written.
	replayed: boolean;
}

// Idempotent by decision id: the update touches only delivery_state, refusal_reason, delivered_at, resolved_at (the
// columns af_control may write) and only while the decision is unresolved. The state transition itself is checked by
// the database triggers, never here.
export const RecordDecisionOutcome = async (repo: Pick<Repo, "decisions">, input: RecordDecisionOutcomeInput): Promise<RecordDecisionOutcomeResult> => {
	if (input.outcome === "refused") {
		if (input.refusalReason === undefined || !isRefusalCode(input.refusalReason)) throw new Error("a refused outcome needs a refusal code as its reason");
	} else if (input.refusalReason !== undefined) throw new Error("an applied outcome carries no refusal reason");
	const written = await repo.decisions.resolveOutcome(input.decisionId, { deliveryState: input.outcome, refusalReason: input.refusalReason ?? null });
	if (written) return { decisionId: written.id, deliveryState: written.deliveryState, refusalReason: written.refusalReason, replayed: false };
	const existing = await repo.decisions.get(input.decisionId);
	if (!existing) throw new DecisionNotFoundError(input.decisionId);
	return { decisionId: existing.id, deliveryState: existing.deliveryState, refusalReason: existing.refusalReason, replayed: true };
};
