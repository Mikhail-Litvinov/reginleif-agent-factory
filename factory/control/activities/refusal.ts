// Refusal codes of the decision handler, docs/agent-factory/temporal.md ("Refusal codes"). `task_closed` is written by
// the relay, never by ReadDecision; the others come from the handler's checks.
export const refusalCodes = ["not_allowed_in_state", "revision_stale", "actor_not_allowed", "already_resolved", "block_kind_mismatch", "block_handled", "task_closed"] as const;
export type RefusalCode = (typeof refusalCodes)[number];

export const isRefusalCode = (value: string): value is RefusalCode => (refusalCodes as readonly string[]).includes(value);

// A decision id that names no row: retrying cannot help, so the activity fails without retry.
export class DecisionNotFoundError extends Error {
	override readonly name = "DecisionNotFoundError";
	readonly decisionId: string;
	constructor(decisionId: string) {
		super(`decision ${decisionId} not found`);
		this.decisionId = decisionId;
	}
}
