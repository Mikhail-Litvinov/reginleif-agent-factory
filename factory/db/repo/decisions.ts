import { and, asc, eq, exists, gt, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { deviceSessions } from "../schema/device-sessions.ts";
import { confirmations, idempotencyKeys, outboxEvents, taskDecisions } from "../schema/decisions.ts";
import { taskEvents } from "../schema/runs.ts";

type DecisionInsert = typeof taskDecisions.$inferInsert;
type Decision = typeof taskDecisions.$inferSelect;
type OutboxInsert = typeof outboxEvents.$inferInsert;
type OutboxEvent = typeof outboxEvents.$inferSelect;
type ConfirmationInsert = typeof confirmations.$inferInsert;
type Confirmation = typeof confirmations.$inferSelect;
type IdempotencyKeyInsert = typeof idempotencyKeys.$inferInsert;
type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

export const decisionRepo = (db: PostgresJsDatabase<any>) => ({
	// Serialize requests for the same principal/key across the decision and confirmation tables.
	lockKey: async (principal: string, key: string): Promise<void> => {
		await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${principal + ':' + key}, 0))`);
	},
	record: async (input: { decision: DecisionInsert; outbox: OutboxInsert }): Promise<{ decision: Decision; outbox: OutboxEvent }> =>
		db.transaction(async (tx) => {
			return decisionRepo(tx).insertPair(input);
		}),
	insertPair: async (input: { decision: DecisionInsert; outbox: OutboxInsert }): Promise<{ decision: Decision; outbox: OutboxEvent }> => {
		const outbox = (await db.insert(outboxEvents).values(input.outbox).returning())[0]!;
		const decision = (await db.insert(taskDecisions).values(input.decision).returning())[0]!;
		return { decision, outbox };
	},
	get: async (id: string): Promise<Decision | undefined> => (await db.select().from(taskDecisions).where(eq(taskDecisions.id, id)).limit(1))[0],
	byActorKey: async (actorId: string, idempotencyKey: string): Promise<Decision | undefined> =>
		(await db.select().from(taskDecisions).where(and(eq(taskDecisions.actorId, actorId), eq(taskDecisions.idempotencyKey, idempotencyKey))).limit(1))[0],
	byEngineerKey: async (engineerRunId: string, idempotencyKey: string): Promise<Decision | undefined> =>
		(await db.select().from(taskDecisions).where(and(eq(taskDecisions.engineerRunId, engineerRunId), eq(taskDecisions.idempotencyKey, idempotencyKey))).limit(1))[0],
	listForTask: async (taskId: string): Promise<Decision[]> => db.select().from(taskDecisions).where(eq(taskDecisions.taskId, taskId)).orderBy(asc(taskDecisions.recordedAt), asc(taskDecisions.id)),
	updateDelivery: async (id: string, patch: Pick<DecisionInsert, "deliveryState" | "refusalReason" | "deliveredAt" | "resolvedAt">): Promise<Decision | null> =>
		(await db.update(taskDecisions).set({ ...patch, updatedAt: sql`now()`, rowVersion: sql`${taskDecisions.rowVersion} + 1` }).where(eq(taskDecisions.id, id)).returning())[0] ?? null,
});

export const outboxRepo = (db: PostgresJsDatabase<any>) => ({
	get: async (id: string): Promise<OutboxEvent | undefined> => (await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1))[0],
	listPending: async (limit?: number): Promise<OutboxEvent[]> => {
		const query = db.select().from(outboxEvents).where(and(or(eq(outboxEvents.state, "pending"), eq(outboxEvents.state, "sent")), or(isNull(outboxEvents.nextAttemptAt), sql`${outboxEvents.nextAttemptAt} <= now()`))).orderBy(asc(outboxEvents.seq));
		return limit === undefined ? query : query.limit(limit);
	},
});

export const confirmationRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: ConfirmationInsert): Promise<Confirmation> => (await db.insert(confirmations).values(input).returning())[0]!,
	get: async (id: string): Promise<Confirmation | undefined> => (await db.select().from(confirmations).where(eq(confirmations.id, id)).limit(1))[0],
	consume: async (input: { id: string; actorId: string; channel: string; deviceSessionId: string | null; operation: string; targetType: string; targetId: string; requestHash: string; now: Date; decisionId?: string }): Promise<Confirmation | null> =>
		(await db.update(confirmations).set({ usedAt: sql`now()`, decisionId: input.decisionId ?? null, updatedAt: sql`now()`, rowVersion: sql`${confirmations.rowVersion} + 1` }).where(and(
			eq(confirmations.id, input.id), eq(confirmations.actorId, input.actorId), eq(confirmations.channel, input.channel),
			eq(confirmations.operation, input.operation), eq(confirmations.targetType, input.targetType), eq(confirmations.targetId, input.targetId),
			eq(confirmations.requestHash, input.requestHash), isNull(confirmations.usedAt), gt(confirmations.expiresAt, input.now),
			input.deviceSessionId === null ? isNull(confirmations.deviceSessionId) : and(
				eq(confirmations.deviceSessionId, input.deviceSessionId), exists(db.select({ id: deviceSessions.id }).from(deviceSessions).where(and(
					eq(deviceSessions.id, input.deviceSessionId), isNull(deviceSessions.revokedAt), or(isNull(deviceSessions.expiresAt), gt(deviceSessions.expiresAt, input.now)),
				))),
			),
		)).returning())[0] ?? null,
});

export const idempotencyKeyRepo = (db: PostgresJsDatabase<any>) => ({
	claim: async (input: IdempotencyKeyInsert): Promise<{ row: IdempotencyKey; replayed: boolean }> => {
		const inserted = await db.insert(idempotencyKeys).values(input).onConflictDoNothing().returning();
		if (inserted[0]) return { row: inserted[0], replayed: false };
		const row = (await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.actorId, input.actorId!), eq(idempotencyKeys.key, input.key!))).limit(1))[0]!;
		return { row, replayed: true };
	},
	get: async (actorId: string, key: string): Promise<IdempotencyKey | undefined> =>
		(await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.actorId, actorId), eq(idempotencyKeys.key, key))).limit(1))[0],
	complete: async (actorId: string, key: string, responseStatus: number, responseBody: unknown): Promise<IdempotencyKey | null> =>
		(await db.update(idempotencyKeys).set({ responseStatus, responseBody, state: "done", updatedAt: sql`now()`, rowVersion: sql`${idempotencyKeys.rowVersion} + 1` }).where(and(eq(idempotencyKeys.actorId, actorId), eq(idempotencyKeys.key, key))).returning())[0] ?? null,
});

export type DecisionRepository = ReturnType<typeof decisionRepo>;

export const taskEventRepo = (db: PostgresJsDatabase<any>) => ({
	persist: async (event: typeof taskEvents.$inferInsert & { taskId: string; dedupeKey: string }): Promise<typeof taskEvents.$inferSelect> => db.transaction(async (tx) => {
		const inserted = (await tx.insert(taskEvents).values(event).onConflictDoNothing({ target: [taskEvents.taskId, taskEvents.dedupeKey] }).returning())[0];
		if (inserted) return inserted;
		const existing = (await tx.select().from(taskEvents).where(and(eq(taskEvents.taskId, event.taskId), eq(taskEvents.dedupeKey, event.dedupeKey))).limit(1))[0];
		if (!existing) throw new Error("task event id conflicts with a different event");
		return existing;
	}),
	stream: async ({ below, after, limit, taskId, runId, type }: { below: string; after?: { commitXid: string; seq: bigint }; limit?: number; taskId?: string; runId?: string; type?: string }) => {
		const conditions = [sql`${taskEvents.commitXid} < ${below}::xid8`];
		if (after) conditions.push(or(gt(taskEvents.commitXid, sql`${after.commitXid}::xid8`), and(eq(taskEvents.commitXid, sql`${after.commitXid}::xid8`), gt(taskEvents.seq, after.seq)))!);
		if (taskId !== undefined) conditions.push(eq(taskEvents.taskId, taskId));
		if (runId !== undefined) conditions.push(eq(taskEvents.runId, runId));
		if (type !== undefined) conditions.push(eq(taskEvents.eventType, type));
		const query = db.select().from(taskEvents).where(and(...conditions)).orderBy(asc(taskEvents.commitXid), asc(taskEvents.seq));
		return limit === undefined ? query : query.limit(limit);
	},
});

export type TaskEventWriter = Pick<ReturnType<typeof taskEventRepo>, "persist">;
