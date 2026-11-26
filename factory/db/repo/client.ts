import { and, asc, desc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { devices } from "../schema/devices.ts";
import { deviceSessions } from "../schema/device-sessions.ts";
import { notifications } from "../schema/decisions.ts";
import { conversations, messages, pollAnswerRequests, polls } from "../schema/chat.ts";

type DeviceInsert = typeof devices.$inferInsert;
type Device = typeof devices.$inferSelect;
type DeviceSessionInsert = typeof deviceSessions.$inferInsert;
type DeviceSession = typeof deviceSessions.$inferSelect;
type NotificationInsert = typeof notifications.$inferInsert;
type Notification = typeof notifications.$inferSelect;
type ConversationInsert = typeof conversations.$inferInsert;
type Conversation = typeof conversations.$inferSelect;
type MessageInsert = typeof messages.$inferInsert;
type Message = typeof messages.$inferSelect;
type PollInsert = typeof polls.$inferInsert;
type Poll = typeof polls.$inferSelect;
type PollAnswerRequestInsert = typeof pollAnswerRequests.$inferInsert;
type PollAnswerRequest = typeof pollAnswerRequests.$inferSelect;
type StreamAfter = { commitXid: string; seq: bigint };

const streamWhere = (commitXid: typeof notifications.commitXid | typeof messages.commitXid, seq: typeof notifications.seq | typeof messages.seq, after?: StreamAfter): SQL[] => {
	const conditions: SQL[] = [sql`${commitXid} < pg_snapshot_xmin(pg_current_snapshot())`];
	if (after) conditions.push(or(gt(commitXid, sql`${after.commitXid}::xid8`), and(eq(commitXid, sql`${after.commitXid}::xid8`), gt(seq, after.seq)))!);
	return conditions;
};

export const deviceRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: DeviceInsert): Promise<Device> => (await db.insert(devices).values(input).returning())[0]!,
	get: async (id: string): Promise<Device | undefined> => (await db.select().from(devices).where(eq(devices.id, id)).limit(1))[0],
	list: async (ownerId: string): Promise<Device[]> => db.select().from(devices).where(eq(devices.ownerId, ownerId)).orderBy(desc(devices.createdAt)),
	consumeCode: async (codeHash: string, now = new Date()): Promise<Device | null> =>
		(await db.update(devices).set({ codeUsedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${devices.rowVersion} + 1` }).where(and(eq(devices.codeHash, codeHash), isNull(devices.codeUsedAt), isNull(devices.revokedAt), gt(devices.codeExpiresAt, now))).returning())[0] ?? null,
	revoke: async (id: string, now = new Date()): Promise<Device | null> =>
		(await db.update(devices).set({ revokedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${devices.rowVersion} + 1` }).where(and(eq(devices.id, id), isNull(devices.revokedAt))).returning())[0] ?? null,
});

export const deviceSessionRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: DeviceSessionInsert): Promise<DeviceSession> => (await db.insert(deviceSessions).values(input).returning())[0]!,
	byTokenHash: async (tokenHash: string, now = new Date()): Promise<DeviceSession | undefined> => (await db.select().from(deviceSessions).where(and(eq(deviceSessions.tokenHash, tokenHash), isNull(deviceSessions.revokedAt), or(isNull(deviceSessions.expiresAt), gt(deviceSessions.expiresAt, now)))).limit(1))[0],
	list: async (deviceId: string): Promise<DeviceSession[]> => db.select().from(deviceSessions).where(eq(deviceSessions.deviceId, deviceId)).orderBy(desc(deviceSessions.createdAt)),
	touch: async (id: string, now = new Date()): Promise<DeviceSession | null> =>
		(await db.update(deviceSessions).set({ lastUsedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${deviceSessions.rowVersion} + 1` }).where(and(eq(deviceSessions.id, id), isNull(deviceSessions.revokedAt), or(isNull(deviceSessions.expiresAt), gt(deviceSessions.expiresAt, now)))).returning())[0] ?? null,
	revoke: async (id: string, now = new Date()): Promise<DeviceSession | null> =>
		(await db.update(deviceSessions).set({ revokedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${deviceSessions.rowVersion} + 1` }).where(and(eq(deviceSessions.id, id), isNull(deviceSessions.revokedAt))).returning())[0] ?? null,
});

export const notificationRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: NotificationInsert): Promise<Notification> => (await db.insert(notifications).values(input).returning())[0]!,
	list: async ({ state, eventType, limit }: { state?: string; eventType?: string; limit?: number } = {}): Promise<Notification[]> => {
		const conditions: SQL[] = [];
		if (state !== undefined) conditions.push(eq(notifications.state, state));
		if (eventType !== undefined) conditions.push(eq(notifications.eventType, eventType));
		const query = db.select().from(notifications).where(and(...conditions)).orderBy(desc(notifications.seq));
		return limit === undefined ? query : query.limit(limit);
	},
	stream: async ({ after, limit }: { after?: StreamAfter; limit?: number } = {}): Promise<Notification[]> => {
		const query = db.select().from(notifications).where(and(...streamWhere(notifications.commitXid, notifications.seq, after))).orderBy(asc(notifications.commitXid), asc(notifications.seq));
		return limit === undefined ? query : query.limit(limit);
	},
	markDelivered: async (id: string, now = new Date()): Promise<Notification | null> =>
		(await db.update(notifications).set({ deliveredAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${notifications.rowVersion} + 1` }).where(and(eq(notifications.id, id), isNull(notifications.deliveredAt))).returning())[0] ?? null,
});

export const conversationRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: ConversationInsert): Promise<Conversation> => (await db.insert(conversations).values(input).returning())[0]!,
	get: async (id: string): Promise<Conversation | undefined> => (await db.select().from(conversations).where(eq(conversations.id, id)).limit(1))[0],
	list: async ({ source, projectId, taskId, archived, limit }: { source?: string; projectId?: string; taskId?: string; archived?: boolean; limit?: number } = {}): Promise<Conversation[]> => {
		const conditions: SQL[] = [];
		if (source !== undefined) conditions.push(eq(conversations.source, source));
		if (projectId !== undefined) conditions.push(eq(conversations.projectId, projectId));
		if (taskId !== undefined) conditions.push(eq(conversations.taskId, taskId));
		if (archived === true) conditions.push(sql`${conversations.archivedAt} IS NOT NULL`);
		if (archived === false) conditions.push(isNull(conversations.archivedAt));
		const query = db.select().from(conversations).where(and(...conditions)).orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, desc(conversations.createdAt));
		return limit === undefined ? query : query.limit(limit);
	},
	updateState: async (id: string, state: string, now = new Date()): Promise<Conversation | null> =>
		(await db.update(conversations).set({ state, updatedAt: sql`now()`, rowVersion: sql`${conversations.rowVersion} + 1` }).where(eq(conversations.id, id)).returning())[0] ?? null,
});

export const messageRepo = (db: PostgresJsDatabase<any>) => ({
	append: async (input: MessageInsert): Promise<Message> => {
		if (input.sourceKey == null) return (await db.insert(messages).values(input).returning())[0]!;
		const inserted = await db.insert(messages).values(input).onConflictDoNothing({ target: [messages.conversationId, messages.sourceKey] }).returning();
		if (inserted[0]) return inserted[0];
		return (await db.select().from(messages).where(and(eq(messages.conversationId, input.conversationId!), eq(messages.sourceKey, input.sourceKey!))).limit(1))[0]!;
	},
	get: async (id: string): Promise<Message | undefined> => (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0],
	listForConversation: async (conversationId: string, limit?: number): Promise<Message[]> => {
		const query = db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.seq));
		return limit === undefined ? query : query.limit(limit);
	},
	stream: async ({ conversationId, after, limit }: { conversationId?: string; after?: StreamAfter; limit?: number } = {}): Promise<Message[]> => {
		const conditions = streamWhere(messages.commitXid, messages.seq, after);
		if (conversationId !== undefined) conditions.push(eq(messages.conversationId, conversationId));
		const query = db.select().from(messages).where(and(...conditions)).orderBy(asc(messages.commitXid), asc(messages.seq));
		return limit === undefined ? query : query.limit(limit);
	},
});

export const pollRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: PollInsert): Promise<Poll> => {
		if (input.sourceKey == null) return (await db.insert(polls).values(input).returning())[0]!;
		const inserted = await db.insert(polls).values(input).onConflictDoNothing({ target: [polls.conversationId, polls.sourceKey] }).returning();
		if (inserted[0]) return inserted[0];
		return (await db.select().from(polls).where(and(eq(polls.conversationId, input.conversationId!), eq(polls.sourceKey, input.sourceKey))).limit(1))[0]!;
	},
	get: async (id: string): Promise<Poll | undefined> => (await db.select().from(polls).where(eq(polls.id, id)).limit(1))[0],
	list: async ({ state, arbiter, limit }: { state?: string; arbiter?: string; limit?: number } = {}): Promise<Poll[]> => {
		const conditions: SQL[] = [];
		if (state !== undefined) conditions.push(eq(polls.state, state));
		if (arbiter !== undefined) conditions.push(eq(polls.arbiter, arbiter));
		const query = db.select().from(polls).where(and(...conditions)).orderBy(desc(polls.createdAt));
		return limit === undefined ? query : query.limit(limit);
	},
	answer: async (id: string, input: { answerKey: string; answeredVia: string; answeredSessionId: string | null; now?: Date }): Promise<Poll | null> => {
		const now = input.now ?? new Date();
		return (await db.update(polls).set({ state: "answered", answerKey: input.answerKey, answeredVia: input.answeredVia, answeredSessionId: input.answeredSessionId, answeredAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${polls.rowVersion} + 1` }).where(and(eq(polls.id, id), eq(polls.state, "open"))).returning())[0] ?? null;
	},
	expire: async (id: string, now = new Date()): Promise<Poll | null> =>
		(await db.update(polls).set({ state: "expired", updatedAt: sql`now()`, rowVersion: sql`${polls.rowVersion} + 1` }).where(and(eq(polls.id, id), eq(polls.state, "open"))).returning())[0] ?? null,
});

export const pollAnswerRequestRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: PollAnswerRequestInsert): Promise<PollAnswerRequest> => {
		const inserted = await db.insert(pollAnswerRequests).values(input).onConflictDoNothing({ target: [pollAnswerRequests.deviceSessionId, pollAnswerRequests.idempotencyKey] }).returning();
		if (inserted[0]) return inserted[0];
		return (await db.select().from(pollAnswerRequests).where(and(eq(pollAnswerRequests.deviceSessionId, input.deviceSessionId!), eq(pollAnswerRequests.idempotencyKey, input.idempotencyKey!))).limit(1))[0]!;
	},
	get: async (id: string): Promise<PollAnswerRequest | undefined> => (await db.select().from(pollAnswerRequests).where(eq(pollAnswerRequests.id, id)).limit(1))[0],
	listForPoll: async (pollId: string, deviceSessionId?: string): Promise<PollAnswerRequest[]> => {
		const conditions: SQL[] = [eq(pollAnswerRequests.pollId, pollId)];
		if (deviceSessionId !== undefined) conditions.push(eq(pollAnswerRequests.deviceSessionId, deviceSessionId));
		return db.select().from(pollAnswerRequests).where(and(...conditions)).orderBy(asc(pollAnswerRequests.createdAt));
	},
	pending: async (limit?: number): Promise<PollAnswerRequest[]> => {
		const query = db.select().from(pollAnswerRequests).where(eq(pollAnswerRequests.state, "pending")).orderBy(asc(pollAnswerRequests.createdAt), asc(pollAnswerRequests.id));
		return limit === undefined ? query : query.limit(limit);
	},
	markDelivered: async (id: string, now = new Date()): Promise<PollAnswerRequest | null> =>
		(await db.update(pollAnswerRequests).set({ deliveredAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${pollAnswerRequests.rowVersion} + 1` }).where(and(eq(pollAnswerRequests.id, id), isNull(pollAnswerRequests.deliveredAt), eq(pollAnswerRequests.state, "pending"))).returning())[0] ?? null,
	decide: async (id: string, result: { state: "accepted" | "refused"; refusalReason?: string; hubRef?: string; now?: Date }): Promise<PollAnswerRequest | null> => {
		const now = result.now ?? new Date();
		return (await db.update(pollAnswerRequests).set({ state: result.state, refusalReason: result.refusalReason ?? null, hubRef: result.hubRef ?? null, decidedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${pollAnswerRequests.rowVersion} + 1` }).where(and(eq(pollAnswerRequests.id, id), eq(pollAnswerRequests.state, "pending"))).returning())[0] ?? null;
	},
});
