import { createHash } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasks } from "../../db/schema/tasks.ts";
import { taskRevisions } from "../../db/schema/decisions.ts";
import { taskProposals } from "../../db/schema/reviews.ts";
import { executionPolicies } from "../../db/schema/execution-policies.ts";
import { policyRepo } from "../../db/repo/policies.ts";

// CreateChildTasks (database.md D19). A `decomposition` proposal is inside the requirements when every id in `covers`
// is in the parent's current acceptance criteria and the limits hold: depth, count per parent, the root's budget. Then
// the child is created without the owner (origin_type decomposition) and the proposal row is `auto_created`. Anything
// else stays `open` for the owner. The limits are the columns of the effective execution policy (project's latest
// version, else the global one), never constants of this file. A limit the policy leaves null is not configured, and an
// unconfigured limit cannot show the proposal is inside it, so the proposal stays open.
// Idempotency key: origin task + proposal id. The proposal row id is the proposal id and the child id is derived from
// both, so a retry finds its row and returns it without a second child.

export interface ChildProposal {
	readonly id: string;
	readonly title: string;
	readonly requirements: string;
	readonly covers: readonly string[];
}

export interface ChildLimits {
	readonly maxDepth: number | null;
	readonly maxChildren: number | null;
	readonly maxTokens: number | null;
	readonly maxCost: number | null;
}

export interface ChildContext {
	readonly parentDepth: number;
	readonly existingChildren: number;
	/**
	 * Spend of the root task and all its descendants (D19: a child's spend counts against the root). null when the
	 * spend cannot be measured: then the budget cannot show the proposal is inside it, so it stays open.
	 */
	readonly spent: { readonly tokens: number; readonly cost: number } | null;
	readonly criteriaIds: ReadonlySet<string>;
}

export type OpenReason = "covers_empty" | "covers_unknown" | "limit_unset" | "depth" | "children" | "budget" | "budget_unmeasured";
export type ChildDecision = { readonly inside: true } | { readonly inside: false; readonly reason: OpenReason };

export const decideChild = (limits: ChildLimits, context: ChildContext, covers: readonly string[]): ChildDecision => {
	if (covers.length === 0) return { inside: false, reason: "covers_empty" };
	if (!covers.every((id) => context.criteriaIds.has(id))) return { inside: false, reason: "covers_unknown" };
	if (limits.maxDepth === null || limits.maxChildren === null || limits.maxTokens === null || limits.maxCost === null) return { inside: false, reason: "limit_unset" };
	if (context.parentDepth + 1 > limits.maxDepth) return { inside: false, reason: "depth" };
	if (context.existingChildren + 1 > limits.maxChildren) return { inside: false, reason: "children" };
	if (context.spent === null) return { inside: false, reason: "budget_unmeasured" };
	if (context.spent.tokens >= limits.maxTokens || context.spent.cost >= limits.maxCost) return { inside: false, reason: "budget" };
	return { inside: true };
};

type Policy = typeof executionPolicies.$inferSelect;
export const limitsOf = (policy: Policy | undefined): ChildLimits => ({
	maxDepth: policy?.maxChildDepth ?? null,
	maxChildren: policy?.maxChildrenPerTask ?? null,
	maxTokens: policy?.maxTokens ?? null,
	maxCost: policy?.maxCost == null ? null : Number(policy.maxCost),
});

/** A stable uuid from the idempotency key, so the child of (parent, proposal) is the same row on every retry. */
export const childId = (parentTaskId: string, proposalId: string, part: "task" | "revision"): string => {
	const hex = createHash("sha256").update(["child", part, parentTaskId, proposalId].join(":")).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export interface CreateChildTasksInput {
	readonly parentTaskId: string;
	readonly runId: string;
	readonly proposals: readonly ChildProposal[];
}

export interface ChildOutcome {
	readonly proposalId: string;
	readonly state: "auto_created" | "open";
	readonly childTaskId: string | null;
	readonly reason: OpenReason | null;
	/** true when the proposal row already existed and this call changed nothing for it. */
	readonly replayed: boolean;
}

/**
 * The spend of the root's tree, for the budget check (database.md D19, task_runs.usage_metrics): the sum over every run
 * of the root task and its descendants of `tokens_in + tokens_out` and `cost_estimate`. A run without those three numeric
 * keys is unmeasured, so the whole spend is null (reason budget_unmeasured); a tree with no runs has spent nothing.
 */
const spentOverTree = async (db: PostgresJsDatabase<any>, taskId: string): Promise<{ tokens: number; cost: number } | null> => {
	const rows = await db.execute(sql`
		with recursive up as (
			select id, parent_task_id from tasks where id = ${taskId}
			union all select t.id, t.parent_task_id from tasks t join up on t.id = up.parent_task_id
		), tree as (
			select id from up where parent_task_id is null
			union all select t.id from tasks t join tree on t.parent_task_id = tree.id
		)
		select
			count(*) filter (where jsonb_typeof(r.usage_metrics -> 'tokens_in') is distinct from 'number'
				or jsonb_typeof(r.usage_metrics -> 'tokens_out') is distinct from 'number'
				or jsonb_typeof(r.usage_metrics -> 'cost_estimate') is distinct from 'number')::int as unmeasured,
			coalesce(sum((r.usage_metrics ->> 'tokens_in')::numeric + (r.usage_metrics ->> 'tokens_out')::numeric), 0)::float8 as tokens,
			coalesce(sum((r.usage_metrics ->> 'cost_estimate')::numeric), 0)::float8 as cost
		from task_runs r join tree on r.task_id = tree.id`);
	const row = (rows as unknown as { unmeasured: number; tokens: number; cost: number }[])[0]!;
	return row.unmeasured > 0 ? null : { tokens: Number(row.tokens), cost: Number(row.cost) };
};

export const CreateChildTasks = async (db: PostgresJsDatabase<any>, input: CreateChildTasksInput): Promise<ChildOutcome[]> => db.transaction(async (tx) => {
	const parent = (await tx.select().from(tasks).where(eq(tasks.id, input.parentTaskId)).limit(1).for("no key update"))[0];
	if (!parent) throw new Error(`task ${input.parentTaskId} was not found`);
	const revision = (await tx.select().from(taskRevisions).where(and(eq(taskRevisions.taskId, parent.id), eq(taskRevisions.revisionNumber, parent.currentRevision!))).limit(1))[0];
	const criteria = (Array.isArray(revision?.acceptanceCriteria) ? revision.acceptanceCriteria : []) as { id?: unknown }[];
	const criteriaIds = new Set(criteria.map((item) => item.id).filter((id): id is string => typeof id === "string"));
	const limits = limitsOf(await policyRepo(tx).effective(parent.projectId));
	const outcomes: ChildOutcome[] = [];
	for (const proposal of input.proposals) {
		const prior = (await tx.select().from(taskProposals).where(eq(taskProposals.id, proposal.id)).limit(1))[0];
		if (prior) {
			outcomes.push({ proposalId: prior.id, state: prior.state === "auto_created" ? "auto_created" : "open", childTaskId: prior.childTaskId, reason: null, replayed: true });
			continue;
		}
		const existingChildren = (await tx.select({ n: count() }).from(tasks).where(eq(tasks.parentTaskId, parent.id)))[0]!.n;
		const spent = await spentOverTree(tx, parent.id);
		const decision = decideChild(limits, { parentDepth: parent.depth, existingChildren, spent, criteriaIds }, proposal.covers);
		const row = { id: proposal.id, taskId: parent.id, runId: input.runId, kind: "decomposition", title: proposal.title, requirements: proposal.requirements, covers: [...proposal.covers] };
		if (!decision.inside) {
			await tx.insert(taskProposals).values({ ...row, state: "open" });
			outcomes.push({ proposalId: proposal.id, state: "open", childTaskId: null, reason: decision.reason, replayed: false });
			continue;
		}
		const taskId = childId(parent.id, proposal.id, "task");
		await tx.insert(tasks).values({
			id: taskId, projectId: parent.projectId, parentTaskId: parent.id, title: proposal.title, description: null, priority: parent.priority,
			status: "CREATED", currentRevision: 1, workflowId: ["task", taskId].join("-"), depth: parent.depth + 1,
			originType: "decomposition", originTaskId: parent.id, originRunId: input.runId, originActor: "workflow",
			pauseRequested: false, stopping: false, endUnconfirmed: false,
		});
		await tx.insert(taskRevisions).values({
			id: childId(parent.id, proposal.id, "revision"), taskId, revisionNumber: 1, requirements: proposal.requirements,
			acceptanceCriteria: criteria.filter((item) => typeof item.id === "string" && proposal.covers.includes(item.id)), constraints: {}, changeReason: "decomposition", authorId: null,
		});
		await tx.insert(taskProposals).values({ ...row, state: "auto_created", childTaskId: taskId });
		outcomes.push({ proposalId: proposal.id, state: "auto_created", childTaskId: taskId, reason: null, replayed: false });
	}
	return outcomes;
});
