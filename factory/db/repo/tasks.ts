import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { canTransition, type BlockKind, type TaskState } from "../../contracts/states.ts";
import { refusing } from "./errors.ts";
import { taskDependencies } from "../schema/task-dependencies.ts";
import { taskRevisions } from "../schema/decisions.ts";
import { tasks } from "../schema/tasks.ts";

type Task = typeof tasks.$inferSelect;
type TaskInsert = typeof tasks.$inferInsert;
type Revision = typeof taskRevisions.$inferSelect;
type Dependency = typeof taskDependencies.$inferSelect;
type InitialRevision = Omit<typeof taskRevisions.$inferInsert, "taskId" | "revisionNumber" | "changeReason" | "authorId">;
type RevisionInput = Omit<typeof taskRevisions.$inferInsert, "taskId" | "revisionNumber" | "createdAt">;
type TransitionPatch = Partial<Pick<TaskInsert, "blockKind" | "blockReason" | "blockHandler" | "resumeTo" | "pauseRequested" | "stopping" | "endUnconfirmed" | "assignedAgentId" | "workflowRunId" | "completedAt" | "currentRevision">>;
type TaskSort = "created_at" | "updated_at" | "priority";
type TaskCreateInput = Pick<TaskInsert, "id"> & {
	projectId: string;
	title: string;
	description?: string | null;
	priority: number;
	createdBy?: string | null;
};

export class TransitionRefusedError extends Error {
	readonly name = "TransitionRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export class DependencyRefusedError extends Error {
	readonly name = "DependencyRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export class TaskDeleteRefusedError extends Error {
	readonly name = "TaskDeleteRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export const TransitionGuard = {
	allows: (from: TaskState, to: TaskState, blockKind?: BlockKind): boolean => canTransition(from, to, blockKind),
};

export const taskRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: TaskCreateInput, initialRevision: InitialRevision): Promise<Task> => db.transaction(async (tx) => {
		const task = (await tx.insert(tasks).values({
			...input, status: "CREATED", currentRevision: 1, workflowId: ["task", input.id].join("-"), depth: 0,
			originType: "owner", pauseRequested: false, stopping: false, endUnconfirmed: false,
		}).returning())[0]!;
		await tx.insert(taskRevisions).values({ ...initialRevision, taskId: task.id, revisionNumber: 1, changeReason: "initial", authorId: input.createdBy ?? null });
		return task;
	}),
	createStanding: async (input: { id: string; projectId: string; createdBy: string; revisionId: string }): Promise<void> => db.transaction(async tx => {
		await tx.insert(tasks).values({ id: input.id, projectId: input.projectId, createdBy: input.createdBy,
			title: "Standing task", description: "", priority: 0, status: "RUNNING", currentRevision: 1,
			workflowId: `task-${input.id}`, depth: 0, originType: "standing", pauseRequested: false, stopping: false, endUnconfirmed: false });
		await tx.insert(taskRevisions).values({ id: input.revisionId, taskId: input.id, revisionNumber: 1,
			requirements: "", acceptanceCriteria: [], constraints: {}, changeReason: "initial", authorId: input.createdBy });
	}),
	get: async (id: string, { includeDeleted = false, lock = false }: { includeDeleted?: boolean; lock?: boolean } = {}): Promise<Task | undefined> => {
		const query = db.select().from(tasks).where(and(eq(tasks.id, id), ...(includeDeleted ? [] : [isNull(tasks.deletedAt)]))).limit(1);
		return (await (lock ? query.for("no key update") : query))[0];
	},
	list: async ({
		includeDeleted = false, projectId, status, priorityGte, agentId, parentId, createdAfter, createdBefore, updatedAfter,
		awaitingApproval, q, originType, sort = "created_at", direction = "desc",
	}: {
		includeDeleted?: boolean; projectId?: string; status?: TaskState | readonly TaskState[]; priorityGte?: number;
		agentId?: string; parentId?: string; createdAfter?: Date; createdBefore?: Date; updatedAfter?: Date;
		awaitingApproval?: boolean; q?: string; originType?: string; sort?: TaskSort; direction?: "asc" | "desc";
	} = {}): Promise<Task[]> => {
		const conditions: SQL[] = [];
		if (!includeDeleted) conditions.push(isNull(tasks.deletedAt));
		if (projectId !== undefined) conditions.push(eq(tasks.projectId, projectId));
		if (status !== undefined) conditions.push(Array.isArray(status) ? inArray(tasks.status, [...status]) : eq(tasks.status, status as TaskState));
		if (priorityGte !== undefined) conditions.push(gte(tasks.priority, priorityGte));
		if (agentId !== undefined) conditions.push(eq(tasks.assignedAgentId, agentId));
		if (parentId !== undefined) conditions.push(eq(tasks.parentTaskId, parentId));
		if (createdAfter !== undefined) conditions.push(gte(tasks.createdAt, createdAfter));
		if (createdBefore !== undefined) conditions.push(lte(tasks.createdAt, createdBefore));
		if (updatedAfter !== undefined) conditions.push(gte(tasks.updatedAt, updatedAfter));
		if (awaitingApproval === true) conditions.push(eq(tasks.status, "AWAITING_APPROVAL"));
		if (q !== undefined) conditions.push(sql`strpos(lower(coalesce(${tasks.title}, '')), lower(${q}::text)) > 0`);
		if (originType !== undefined) conditions.push(eq(tasks.originType, originType));
		const orderColumn = sort === "updated_at" ? tasks.updatedAt : sort === "priority" ? tasks.priority : tasks.createdAt;
		return db.select().from(tasks).where(and(...conditions)).orderBy(direction === "asc" ? asc(orderColumn) : desc(orderColumn));
	},
	transition: async (id: string, expectedVersion: bigint, to: TaskState, patch: TransitionPatch = {}): Promise<Task | null> => {
		const current = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.rowVersion, expectedVersion), isNull(tasks.deletedAt))).limit(1);
		if (!current[0]) return null;
		const handoff = current[0].status === "BLOCKED" && to === "BLOCKED" && current[0].blockHandler === "chief_engineer" && patch.blockHandler === "owner";
		if (!handoff && !TransitionGuard.allows(current[0].status as TaskState, to, (current[0].blockKind ?? undefined) as BlockKind | undefined)) throw new TransitionRefusedError("illegal task transition");
		const clearBlock = current[0].status === "BLOCKED" && to !== "BLOCKED" ? { blockKind: null, blockHandler: null } : {};
		const clearPause = current[0].status === "PAUSED" && to !== "PAUSED" ? { resumeTo: null } : {};
		return refusing((reason) => new TransitionRefusedError(reason), async () =>
			(await db.update(tasks).set({ ...clearBlock, ...clearPause, ...patch, status: to, updatedAt: new Date(), rowVersion: expectedVersion + 1n })
				.where(and(eq(tasks.id, id), eq(tasks.rowVersion, expectedVersion), isNull(tasks.deletedAt))).returning())[0] ?? null);
	},
	softDelete: async (id: string, expectedVersion: bigint): Promise<Task | null> =>
		refusing((reason) => new TaskDeleteRefusedError(reason), async () =>
			(await db.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date(), rowVersion: expectedVersion + 1n })
				.where(and(eq(tasks.id, id), eq(tasks.rowVersion, expectedVersion), isNull(tasks.deletedAt))).returning())[0] ?? null),
	revisions: async (taskId: string): Promise<Revision[]> =>
		db.select().from(taskRevisions).where(eq(taskRevisions.taskId, taskId)).orderBy(asc(taskRevisions.revisionNumber)),
	getRevision: async (taskId: string, revisionNumber: number): Promise<Revision | undefined> =>
		(await db.select().from(taskRevisions).where(and(eq(taskRevisions.taskId, taskId), eq(taskRevisions.revisionNumber, revisionNumber))).limit(1))[0],
	appendRevision: async (taskId: string, input: RevisionInput): Promise<Revision | null> => db.transaction(async (tx) => {
		const task = (await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for("update").limit(1))[0];
		if (!task) return null;
		const revisions = await tx.select({ revisionNumber: taskRevisions.revisionNumber }).from(taskRevisions)
			.where(eq(taskRevisions.taskId, taskId)).orderBy(desc(taskRevisions.revisionNumber)).limit(1);
		const revisionNumber = (revisions[0]?.revisionNumber ?? 0) + 1;
		return (await tx.insert(taskRevisions).values({ ...input, taskId, revisionNumber }).returning())[0]!;
	}),
	dependencies: async (taskId: string, { includeRemoved = false }: { includeRemoved?: boolean } = {}): Promise<Dependency[]> =>
		db.select().from(taskDependencies).where(and(eq(taskDependencies.taskId, taskId), ...(includeRemoved ? [] : [isNull(taskDependencies.removedAt)])))
			.orderBy(asc(taskDependencies.createdAt), asc(taskDependencies.dependsOnTaskId)),
	addDependency: async (taskId: string, dependsOnTaskId: string, dependencyType: "requires_accepted"): Promise<Dependency> =>
		refusing((reason) => new DependencyRefusedError(reason), async () =>
			(await db.insert(taskDependencies).values({ taskId, dependsOnTaskId, dependencyType }).returning())[0]!),
	removeDependency: async (taskId: string, dependsOnTaskId: string, expectedVersion: bigint, removedBy?: string): Promise<Dependency | null> =>
		refusing((reason) => new DependencyRefusedError(reason), async () =>
			(await db.update(taskDependencies).set({ removedAt: new Date(), removedBy, updatedAt: new Date(), rowVersion: expectedVersion + 1n })
				.where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, dependsOnTaskId), eq(taskDependencies.rowVersion, expectedVersion), isNull(taskDependencies.removedAt))).returning())[0] ?? null),
});

export type TaskRepository = ReturnType<typeof taskRepo>;
