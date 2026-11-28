// Read-only queries the routing activities need (SelectAgent, PrepareTask); kept apart from the shared repos.
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { agents } from '../schema/agents.ts';
import { taskDecisions } from '../schema/decisions.ts';
import { taskEvents, taskRuns } from '../schema/runs.ts';
import { tasks } from '../schema/tasks.ts';

/** Task statuses in which a task holds an agent and counts against the project and agent limits. */
export const HOLDING_STATUSES = ['ASSIGNED', 'RUNNING', 'VERIFYING'] as const;

export const routingReadRepo = (db: PostgresJsDatabase<any>) => ({
	/** The stored task event of one dedupe key (task_events_task_dedupe is unique), or undefined. */
	eventByDedupe: async (taskId: string, dedupeKey: string) =>
		(await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.dedupeKey, dedupeKey))).limit(1))[0],
	/** Live tasks holding an agent: total of the project and per agent, `exceptTaskId` (the task being routed) excluded. */
	holding: async (projectId: string, exceptTaskId: string) => {
		const rows = await db.select({ agentId: tasks.assignedAgentId, n: sql<number>`count(*)::int` }).from(tasks).where(and(
			eq(tasks.projectId, projectId), inArray(tasks.status, [...HOLDING_STATUSES]), isNull(tasks.deletedAt), ne(tasks.id, exceptTaskId))).groupBy(tasks.assignedAgentId);
		return { projectActive: rows.reduce((sum, r) => sum + r.n, 0), agentActive: Object.fromEntries(rows.filter((r) => r.agentId !== null).map((r) => [r.agentId!, r.n])) as Record<string, number> };
	},
	/** Runs that occupy a worker now, per worker. */
	workerActive: async () => {
		const rows = await db.select({ workerId: taskRuns.workerId, n: sql<number>`count(*)::int` }).from(taskRuns)
			.where(inArray(taskRuns.status, ['created', 'starting', 'running', 'cancelling'])).groupBy(taskRuns.workerId);
		return Object.fromEntries(rows.filter((r) => r.workerId !== null).map((r) => [r.workerId!, r.n])) as Record<string, number>;
	},
	/** Providers of the implementer runs of a task (D20: a review runs on another provider). */
	implementerProviders: async (taskId: string): Promise<string[]> => {
		const rows = await db.selectDistinct({ provider: agents.provider }).from(taskRuns).innerJoin(agents, eq(agents.id, taskRuns.agentId))
			.where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.role, 'implementer')));
		return rows.map((r) => r.provider).filter((p): p is string => p !== null);
	},
	/** Finished implementer runs per agent: the past-outcome tie-break of the ranking. */
	pastSuccesses: async (): Promise<Record<string, number>> => {
		const rows = await db.select({ agentId: taskRuns.agentId, n: sql<number>`count(*)::int` }).from(taskRuns)
			.where(and(eq(taskRuns.status, 'finished'), eq(taskRuns.role, 'implementer'))).groupBy(taskRuns.agentId);
		return Object.fromEntries(rows.filter((r) => r.agentId !== null).map((r) => [r.agentId!, r.n]));
	},
	/** Agent ids of the `allow_agent` decisions of a task (payload `{agent_id}`), or null when the owner made none. */
	allowedAgents: async (taskId: string): Promise<string[] | null> => {
		const rows = await db.select({ payload: taskDecisions.payload }).from(taskDecisions).where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.kind, 'allow_agent')));
		const ids = rows.map((r) => (r.payload as { agent_id?: unknown } | null)?.agent_id).filter((id): id is string => typeof id === 'string');
		return ids.length === 0 ? null : ids;
	},
});
