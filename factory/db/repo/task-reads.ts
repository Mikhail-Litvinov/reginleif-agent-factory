import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { reviewFindingOutcomes, taskReviews } from '../schema/reviews.ts';
import { taskArtifacts, taskRuns } from '../schema/runs.ts';

export const taskReadRepo = (db: PostgresJsDatabase<any>) => ({
  runs: (taskId: string, { status, role }: { status?: string; role?: string } = {}) => db.select().from(taskRuns).where(and(
    eq(taskRuns.taskId, taskId), status === undefined ? undefined : eq(taskRuns.status, status),
    role === undefined ? undefined : eq(taskRuns.role, role),
  )),
  engineerRun: async (taskId: string, workerId: string, runId?: string | null, includeFinished = false) => {
    const bound = and(eq(taskRuns.taskId, taskId), eq(taskRuns.workerId, workerId), eq(taskRuns.role, 'chief_engineer'),
      runId ? eq(taskRuns.id, runId) : undefined);
    const active = await db.select().from(taskRuns).where(and(bound, inArray(taskRuns.status, ['starting', 'running']), isNull(taskRuns.finishedAt))).limit(2);
    // An authenticated run may replay a previous response after finishing, but only a live run can record a new decision.
    const candidates = active.length || !includeFinished ? active : await db.select().from(taskRuns).where(bound).limit(2);
    return candidates.length === 1 ? candidates[0] : undefined;
  },
  artifacts: ({ taskId, runId, type, workerId, includeDeleted }: {
    taskId: string; runId?: string; type?: string; workerId?: string; includeDeleted: boolean;
  }) => db.select({ artifact: taskArtifacts }).from(taskArtifacts)
    .leftJoin(taskRuns, and(eq(taskArtifacts.runId, taskRuns.id), eq(taskRuns.taskId, taskId)))
    .where(and(eq(taskArtifacts.taskId, taskId), runId === undefined ? undefined : eq(taskArtifacts.runId, runId),
      type === undefined ? undefined : eq(taskArtifacts.artifactType, type),
      workerId === undefined ? undefined : eq(taskRuns.workerId, workerId),
      includeDeleted ? undefined : isNull(taskArtifacts.removedAt))).then(rows => rows.map(({ artifact }) => artifact)),
  reviews: async (taskId: string) => {
    const reviews = await db.select().from(taskReviews).where(eq(taskReviews.taskId, taskId));
    if (!reviews.length) return [];
    const outcomes = await db.select().from(reviewFindingOutcomes).where(inArray(reviewFindingOutcomes.reviewId, reviews.map(review => review.id)))
      .orderBy(reviewFindingOutcomes.createdAt, reviewFindingOutcomes.id);
    const grouped = new Map<string | null, typeof outcomes>();
    for (const outcome of outcomes) {
      const entries = grouped.get(outcome.reviewId) ?? [];
      entries.push(outcome);
      grouped.set(outcome.reviewId, entries);
    }
    return reviews.map(review => ({ ...review, outcomes: grouped.get(review.id) ?? [] }));
  },
});
