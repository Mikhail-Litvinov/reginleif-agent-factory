import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agents } from "../../db/schema/agents.ts";
import { taskRuns } from "../../db/schema/runs.ts";
import { taskReviews } from "../../db/schema/reviews.ts";

// RequestReview (temporal.md step 7, D20). Picks the reviewer; it never decides a verdict. Independence is the rule of
// the database trigger af_0005_review_independence (a review by the implementer, or by an agent of an implementer's
// provider, is refused at insert); this activity applies the same rule before a reviewer run is spent, so the trigger
// stays the guard and not the selector. Idempotency key: task + round; a retry returns the same pick, and a round that
// already has a review row returns that reviewer.

export interface ReviewerCandidate {
	readonly id: string;
	readonly provider: string | null;
	readonly enabled: boolean;
	/** `capabilities.roles` of the agent (agent-adapters.md getCapabilities); a reviewer must list "reviewer". */
	readonly roles?: readonly string[];
}

export type ReviewerChoice =
	| { readonly kind: "reviewer"; readonly agentId: string; readonly provider: string }
	| { readonly kind: "none"; readonly reason: "no_other_provider" };

/**
 * temporal.md Reviewer (D20): enabled, another provider than every implementer, not an implementer itself, and its
 * declared roles list "reviewer" (a planner reviews only then). An agent whose provider is unknown can never be shown
 * independent, so it never counts as a reviewer.
 */
export const pickReviewer = (candidates: readonly ReviewerCandidate[], implementers: readonly ReviewerCandidate[]): ReviewerChoice => {
	const barred = new Set(implementers.map((agent) => agent.provider));
	const barredIds = new Set(implementers.map((agent) => agent.id));
	const eligible = candidates
		.filter((agent) => agent.enabled && agent.provider !== null && !barred.has(agent.provider) && !barredIds.has(agent.id) && (agent.roles ?? []).includes("reviewer"))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const chosen = eligible[0];
	return chosen ? { kind: "reviewer", agentId: chosen.id, provider: chosen.provider! } : { kind: "none", reason: "no_other_provider" };
};

export type MandatoryCheck = { readonly name: string; readonly mandatory: boolean; readonly status: "passed" | "failed" | "not_run" };

export type CheckGate =
	| { readonly kind: "proceed" }
	| { readonly kind: "failed"; readonly names: readonly string[] }
	| { readonly kind: "repair"; readonly names: readonly string[] }
	| { readonly kind: "blocked"; readonly blockKind: "check_environment"; readonly handler: "chief_engineer"; readonly names: readonly string[] };

/**
 * D26 check-not-run. A mandatory check that did not run is not a pass: the first time it gets one repair attempt, the
 * second time the task is BLOCKED `check_environment` for the chief engineer. It never leads on to review or to
 * AWAITING_APPROVAL. A failed mandatory check is a failure, not an environment problem.
 */
export const gateMandatoryChecks = (checks: readonly MandatoryCheck[], repairAttempted: boolean): CheckGate => {
	const mandatory = checks.filter((check) => check.mandatory);
	const failed = mandatory.filter((check) => check.status === "failed").map((check) => check.name);
	if (failed.length > 0) return { kind: "failed", names: failed };
	const notRun = mandatory.filter((check) => check.status === "not_run").map((check) => check.name);
	if (notRun.length === 0) return { kind: "proceed" };
	return repairAttempted ? { kind: "blocked", blockKind: "check_environment", handler: "chief_engineer", names: notRun } : { kind: "repair", names: notRun };
};

export interface RequestReviewInput {
	readonly taskId: string;
	readonly round: number;
	readonly checks: readonly MandatoryCheck[];
	readonly repairAttempted: boolean;
}

export type RequestReviewResult =
	| { readonly kind: "reviewer"; readonly agentId: string; readonly provider: string; readonly existingReviewId: string | null }
	| { readonly kind: "none"; readonly reason: "no_other_provider" }
	| Exclude<CheckGate, { kind: "proceed" }>;

export const RequestReview = async (db: PostgresJsDatabase<any>, input: RequestReviewInput): Promise<RequestReviewResult> => {
	const gate = gateMandatoryChecks(input.checks, input.repairAttempted);
	if (gate.kind !== "proceed") return gate;
	const prior = (await db.select({ id: taskReviews.id, reviewerId: taskReviews.reviewerId, provider: agents.provider }).from(taskReviews)
		.innerJoin(agents, eq(agents.id, taskReviews.reviewerId))
		.where(and(eq(taskReviews.taskId, input.taskId), eq(taskReviews.round, input.round))).limit(1))[0];
	if (prior) return { kind: "reviewer", agentId: prior.reviewerId!, provider: prior.provider!, existingReviewId: prior.id };
	const implementers = await db.selectDistinct({ id: agents.id, provider: agents.provider, enabled: agents.enabled }).from(taskRuns)
		.innerJoin(agents, eq(agents.id, taskRuns.agentId))
		.where(and(eq(taskRuns.taskId, input.taskId), eq(taskRuns.role, "implementer")));
	const candidates = await db.select({ id: agents.id, provider: agents.provider, enabled: agents.enabled, capabilities: agents.capabilities }).from(agents).where(isNull(agents.deletedAt));
	const rolesOf = (capabilities: unknown): string[] => {
		const roles = (capabilities as { roles?: unknown } | null)?.roles;
		return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
	};
	const choice = pickReviewer(candidates.map((a) => ({ id: a.id, provider: a.provider, enabled: a.enabled === true, roles: rolesOf(a.capabilities) })), implementers.map((a) => ({ ...a, enabled: a.enabled === true })));
	return choice.kind === "reviewer" ? { ...choice, existingReviewId: null } : choice;
};
