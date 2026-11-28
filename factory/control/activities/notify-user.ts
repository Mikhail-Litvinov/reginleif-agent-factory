import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { notifications } from "../../db/schema/decisions.ts";

// NotifyUser (temporal.md activity table): writes the notice through the repo path and nothing else. Delivery stays
// with the API and the client (the client reads the notifications stream and marks delivery), so this activity never
// calls a messenger. Raising a notice whose key is already open is one atomic upsert on the unique partial index
// notifications_open_dedup: the open row gets `occurrences + 1` and a new `last_raised_at` (database.md, Notifications),
// so one outage gives one message and a count of how often it was raised. Concurrent raises serialize on that index
// entry, so two raises give occurrences 2.
type Notification = typeof notifications.$inferSelect;

export type NoticeEventType = NonNullable<Notification["eventType"]>;

export interface NotifyUserInput {
	readonly id: string;
	readonly eventType: NoticeEventType;
	readonly dedupKey: string;
	readonly taskId: string | null;
	readonly workerId?: string | null;
	readonly now: Date;
}

export interface NotifyUserResult {
	readonly notification: Notification;
	/** true when this call opened the notice; false when an open notice with the same key was bumped instead. */
	readonly created: boolean;
}

export const NotifyUser = async (db: PostgresJsDatabase<any>, input: NotifyUserInput): Promise<NotifyUserResult> => {
	const row = (await db.insert(notifications).values({
		id: input.id, eventType: input.eventType, dedupKey: input.dedupKey, taskId: input.taskId, workerId: input.workerId ?? null,
		state: "open", occurrences: 1, firstRaisedAt: input.now, lastRaisedAt: input.now,
	}).onConflictDoUpdate({
		target: notifications.dedupKey,
		targetWhere: sql`${notifications.state} = 'open'`,
		set: { occurrences: sql`${notifications.occurrences} + 1`, lastRaisedAt: input.now },
	}).returning())[0];
	if (!row) throw new Error(`notice ${input.dedupKey} was neither created nor bumped`);
	return { notification: row, created: row.occurrences === 1 };
};
