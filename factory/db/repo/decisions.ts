import { and, asc, eq, exists, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
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
		await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${principal}::text || ':' || ${key}::text, 0))`);
	},
	tryLockKey: async (principal: string, key: string): Promise<boolean> =>
		(await db.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${principal}::text || ':' || ${key}::text, 0)) as locked`))[0]!.locked,
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

const finishOutbox = async (db: PostgresJsDatabase<any>, id: string, owner: string, patch: { [K in keyof OutboxInsert]?: OutboxInsert[K] | SQL }): Promise<boolean> =>
	(await db.update(outboxEvents).set({ ...patch, leaseOwner: null, leaseUntil: null, updatedAt: sql`now()`, rowVersion: sql`${outboxEvents.rowVersion} + 1` })
		.where(and(eq(outboxEvents.id, id), eq(outboxEvents.leaseOwner, owner), eq(outboxEvents.state, "pending"))).returning({ id: outboxEvents.id })).length === 1;

export type OutboxRepository = ReturnType<typeof outboxRepo>;

export const outboxRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: OutboxInsert): Promise<OutboxEvent> => (await db.insert(outboxEvents).values(input).returning())[0]!,
	get: async (id: string): Promise<OutboxEvent | undefined> => (await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1))[0],
	// Lease (database.md: the relay claims a row with `for update skip locked`). One statement picks the oldest due `pending`
		// rows nobody holds (no lease, or a lease that ran out: a relay that died midway) and stamps them with this owner. Only
		// the columns af_control may write are set, and every time comes from the database clock. `attempts` counts claims.
		// Per-task order (temporal.md "Delivery order"): a row with a task is claimable only while no older row of that task
		// (smaller `seq`) is still `pending`, leased or not, or `failed`. `sent` and `done` rows do not block. A leased older row is
		// still `pending` for every other transaction until its relay commits the mark, so a second relay cannot overtake it. The
		// check sees the states as they were before this statement, so one claim takes at most one row per task.
		claim: async (input: { owner: string; leaseSeconds: number; limit: number }): Promise<OutboxEvent[]> => {
			const due = db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
				eq(outboxEvents.state, "pending"),
				or(isNull(outboxEvents.nextAttemptAt), sql`${outboxEvents.nextAttemptAt} <= now()`),
				or(isNull(outboxEvents.leaseUntil), sql`${outboxEvents.leaseUntil} <= now()`),
				or(isNull(outboxEvents.taskId), sql`not exists (select 1 from outbox_events older where older.task_id = ${outboxEvents.taskId} and older.seq < ${outboxEvents.seq} and older.state in ('pending', 'failed'))`),
			)).orderBy(asc(outboxEvents.seq)).limit(input.limit).for("update", { skipLocked: true });
			const rows = await db.update(outboxEvents).set({
				leaseOwner: input.owner, leaseUntil: sql`now() + make_interval(secs => ${input.leaseSeconds}::double precision)`,
				attempts: sql`coalesce(${outboxEvents.attempts}, 0) + 1`, updatedAt: sql`now()`, rowVersion: sql`${outboxEvents.rowVersion} + 1`,
			}).where(inArray(outboxEvents.id, due)).returning();
			return rows.sort((a, b) => (a.seq! < b.seq! ? -1 : a.seq! > b.seq! ? 1 : 0));
		},
		// Extends a lease still held by `owner`; false means it ran out or went to another relay.
		extend: async (id: string, owner: string, leaseSeconds: number): Promise<boolean> =>
			(await db.update(outboxEvents).set({ leaseUntil: sql`now() + make_interval(secs => ${leaseSeconds}::double precision)`, updatedAt: sql`now()`, rowVersion: sql`${outboxEvents.rowVersion} + 1` })
				.where(and(eq(outboxEvents.id, id), eq(outboxEvents.leaseOwner, owner), eq(outboxEvents.state, "pending"), sql`${outboxEvents.leaseUntil} > now()`)).returning({ id: outboxEvents.id })).length === 1,
		// The ends of a claimed row. Each writes only while `owner` is still the lease owner of a `pending` row, and clears the
		// lease; false means another relay took the row over, whose repeat is harmless (the Update id is stable per decision).
		// `sent` is not final (temporal.md "Sent and done"): the sent sweep (listSent, closeSent) closes the row later.
		markSent: async (id: string, owner: string): Promise<boolean> => finishOutbox(db, id, owner, { state: "sent", lastError: null }),
		markDone: async (id: string, owner: string): Promise<boolean> => finishOutbox(db, id, owner, { state: "done", doneAt: sql`now()`, lastError: null }),
		markFailed: async (id: string, owner: string, error: string): Promise<boolean> => finishOutbox(db, id, owner, { state: "failed", lastError: error }),
		// A retryable failure: the row stays `pending`, the lease is dropped, and the row is due again after `retryAfterSeconds`.
		release: async (id: string, owner: string, error: string, retryAfterSeconds: number): Promise<boolean> =>
			finishOutbox(db, id, owner, { lastError: error, nextAttemptAt: sql`now() + make_interval(secs => ${retryAfterSeconds}::double precision)` }),
		// The sent sweep. `sent` rows whose check time has come, oldest first; the relay closes a row once PostgreSQL shows its effect.
		listSent: async (limit: number): Promise<OutboxEvent[]> =>
			db.select().from(outboxEvents).where(and(eq(outboxEvents.state, "sent"), or(isNull(outboxEvents.nextAttemptAt), sql`${outboxEvents.nextAttemptAt} <= now()`))).orderBy(asc(outboxEvents.seq)).limit(limit),
		// `sent` -> `done` (no lease involved: a `sent` row is held by nobody). False when the row is not `sent` any more.
		closeSent: async (id: string): Promise<boolean> =>
			(await db.update(outboxEvents).set({ state: "done", doneAt: sql`now()`, nextAttemptAt: null, updatedAt: sql`now()`, rowVersion: sql`${outboxEvents.rowVersion} + 1` })
				.where(and(eq(outboxEvents.id, id), eq(outboxEvents.state, "sent"))).returning({ id: outboxEvents.id })).length === 1,
		// The effect of a `sent` row is not visible yet: look again after `seconds`; the row is not delivered again.
		recheckSent: async (id: string, seconds: number): Promise<boolean> =>
			(await db.update(outboxEvents).set({ nextAttemptAt: sql`now() + make_interval(secs => ${seconds}::double precision)`, updatedAt: sql`now()`, rowVersion: sql`${outboxEvents.rowVersion} + 1` })
				.where(and(eq(outboxEvents.id, id), eq(outboxEvents.state, "sent"))).returning({ id: outboxEvents.id })).length === 1,
		listPending: async (limit?: number): Promise<OutboxEvent[]> => {
		const query = db.select().from(outboxEvents).where(and(or(eq(outboxEvents.state, "pending"), eq(outboxEvents.state, "sent")), or(isNull(outboxEvents.nextAttemptAt), sql`${outboxEvents.nextAttemptAt} <= now()`))).orderBy(asc(outboxEvents.seq));
		return limit === undefined ? query : query.limit(limit);
	},
});

export const confirmationRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: ConfirmationInsert): Promise<Confirmation> => (await db.insert(confirmations).values(input).returning())[0]!,
	get: async (id: string): Promise<Confirmation | undefined> => (await db.select().from(confirmations).where(eq(confirmations.id, id)).limit(1))[0],
	consume: async (input: { id: string; actorId: string; channel: string; deviceSessionId: string | null; operation: string; targetType: string; targetId: string; requestHash: string; now: Date; decisionId?: string }): Promise<Confirmation | null> =>
		(await db.update(confirmations).set({ usedAt: input.now, decisionId: input.decisionId ?? null, updatedAt: sql`now()`, rowVersion: sql`${confirmations.rowVersion} + 1` }).where(and(
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
