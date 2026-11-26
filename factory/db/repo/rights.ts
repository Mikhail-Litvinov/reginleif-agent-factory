import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { refusing } from "./errors.ts";
import { rightAnswers, rightGrants, rightRequests, rightsSuspensions, roleAssignments, roles } from "../schema/rights.ts";

type RoleInsert = typeof roles.$inferInsert;
type Role = typeof roles.$inferSelect;
type RoleAssignmentInsert = typeof roleAssignments.$inferInsert;
type RoleAssignment = typeof roleAssignments.$inferSelect;
type RightRequestInsert = typeof rightRequests.$inferInsert;
type RightRequest = typeof rightRequests.$inferSelect;
type RightAnswerInsert = typeof rightAnswers.$inferInsert;
type RightAnswer = typeof rightAnswers.$inferSelect;
type RightGrant = typeof rightGrants.$inferSelect;
type RightsSuspensionInsert = typeof rightsSuspensions.$inferInsert;
type RightsSuspension = typeof rightsSuspensions.$inferSelect;

export class RightAnswerRefusedError extends Error {
	readonly name = "RightAnswerRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export class RightGrantRefusedError extends Error {
	readonly name = "RightGrantRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export class RightsSuspensionRefusedError extends Error {
	readonly name = "RightsSuspensionRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

export const roleRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: RoleInsert): Promise<Role> => db.insert(roles).values(input).returning().then(([row]) => row!),
	get: async (id: string): Promise<Role | undefined> => (await db.select().from(roles).where(eq(roles.id, id)).limit(1))[0],
	list: async ({ name, status, regulationVersionId }: { name?: string; status?: string; regulationVersionId?: string } = {}): Promise<Role[]> => {
		const conditions: SQL[] = [];
		if (name !== undefined) conditions.push(eq(roles.name, name));
		if (status !== undefined) conditions.push(eq(roles.status, status));
		if (regulationVersionId !== undefined) conditions.push(eq(roles.regulationVersionId, regulationVersionId));
		return db.select().from(roles).where(and(...conditions)).orderBy(asc(roles.name), asc(roles.version));
	},
	setStatus: async (id: string, status: string): Promise<Role | null> =>
		(await db.update(roles).set({ status, statusChangedAt: sql`now()` }).where(eq(roles.id, id)).returning())[0] ?? null,
});

export const roleAssignmentRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: RoleAssignmentInsert): Promise<RoleAssignment> => db.insert(roleAssignments).values(input).returning().then(([row]) => row!),
	get: async (id: string): Promise<RoleAssignment | undefined> => (await db.select().from(roleAssignments).where(eq(roleAssignments.id, id)).limit(1))[0],
	listForTask: async (taskId: string, { includeSuperseded = false }: { includeSuperseded?: boolean } = {}): Promise<RoleAssignment[]> =>
		db.select().from(roleAssignments).where(and(eq(roleAssignments.taskId, taskId), ...(includeSuperseded ? [] : [isNull(roleAssignments.supersededAt)]))).orderBy(asc(roleAssignments.createdAt), asc(roleAssignments.id)),
	supersede: async (id: string): Promise<RoleAssignment | null> =>
		(await db.update(roleAssignments).set({ supersededAt: sql`now()` }).where(and(eq(roleAssignments.id, id), isNull(roleAssignments.supersededAt))).returning())[0] ?? null,
});

export const rightRequestRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: RightRequestInsert): Promise<RightRequest> => db.insert(rightRequests).values(input).returning().then(([row]) => row!),
	get: async (id: string): Promise<RightRequest | undefined> => (await db.select().from(rightRequests).where(eq(rightRequests.id, id)).limit(1))[0],
	list: async ({ taskId, sessionRef, participant, requestHash }: { taskId?: string; sessionRef?: string; participant?: string; requestHash?: string } = {}): Promise<RightRequest[]> => {
		const conditions: SQL[] = [];
		if (taskId !== undefined) conditions.push(eq(rightRequests.taskId, taskId));
		if (sessionRef !== undefined) conditions.push(eq(rightRequests.sessionRef, sessionRef));
		if (participant !== undefined) conditions.push(eq(rightRequests.participant, participant));
		if (requestHash !== undefined) conditions.push(eq(rightRequests.requestHash, requestHash));
		return db.select().from(rightRequests).where(and(...conditions)).orderBy(desc(rightRequests.createdAt), desc(rightRequests.id));
	},
});

export const rightAnswerRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: RightAnswerInsert): Promise<RightAnswer> => refusing((reason) => new RightAnswerRefusedError(reason), async () =>
		(await db.insert(rightAnswers).values(input).returning())[0]!),
	listForRequest: async (requestId: string): Promise<RightAnswer[]> =>
		db.select().from(rightAnswers).where(eq(rightAnswers.requestId, requestId)).orderBy(asc(rightAnswers.step)),
});

export const rightGrantRepo = (db: PostgresJsDatabase<any>) => ({
	get: async (id: string): Promise<RightGrant | undefined> => (await db.select().from(rightGrants).where(eq(rightGrants.id, id)).limit(1))[0],
	list: async ({ taskId, sessionRef, participant, state }: { taskId?: string; sessionRef?: string; participant?: string; state?: "live" | "ended" | "revoked" | "critical" } = {}): Promise<RightGrant[]> => {
		const conditions: SQL[] = [];
		if (taskId !== undefined) conditions.push(eq(rightGrants.taskId, taskId));
		if (sessionRef !== undefined) conditions.push(eq(rightGrants.sessionRef, sessionRef));
		if (participant !== undefined) conditions.push(eq(rightGrants.participant, participant));
		if (state === "live") conditions.push(isNull(rightGrants.endedAt));
		if (state === "ended") conditions.push(or(eq(rightGrants.endedBy, "task_end"), eq(rightGrants.endedBy, "session_end"))!);
		if (state === "revoked") conditions.push(eq(rightGrants.endedBy, "revocation"));
		if (state === "critical") conditions.push(eq(rightGrants.endedBy, "critical"));
		return db.select().from(rightGrants).where(and(...conditions)).orderBy(desc(rightGrants.createdAt), desc(rightGrants.id));
	},
	end: async (id: string, input: { endedBy: "task_end" | "session_end" | "revocation" | "critical"; revokedBy?: string | null; suspensionId?: string | null }): Promise<RightGrant | null> =>
		refusing((reason) => new RightGrantRefusedError(reason), async () =>
			(await db.update(rightGrants).set({ endedAt: sql`now()`, endedBy: input.endedBy, revokedBy: input.revokedBy ?? null, suspensionId: input.suspensionId ?? null }).where(and(eq(rightGrants.id, id), isNull(rightGrants.endedAt))).returning())[0] ?? null),
});

export const rightsSuspensionRepo = (db: PostgresJsDatabase<any>) => ({
	create: async (input: RightsSuspensionInsert): Promise<RightsSuspension> => refusing((reason) => new RightsSuspensionRefusedError(reason), async () =>
		(await db.insert(rightsSuspensions).values(input).returning())[0]!),
	get: async (id: string): Promise<RightsSuspension | undefined> => (await db.select().from(rightsSuspensions).where(eq(rightsSuspensions.id, id)).limit(1))[0],
	list: async ({ agentId, state }: { agentId?: string; state?: "open" | "restored" } = {}): Promise<RightsSuspension[]> => {
		const conditions: SQL[] = [];
		if (agentId !== undefined) conditions.push(eq(rightsSuspensions.agentId, agentId));
		if (state === "open") conditions.push(isNull(rightsSuspensions.endedAt));
		if (state === "restored") conditions.push(isNotNull(rightsSuspensions.endedAt));
		return db.select().from(rightsSuspensions).where(and(...conditions)).orderBy(desc(rightsSuspensions.createdAt), desc(rightsSuspensions.id));
	},
	restore: async (id: string, input: { restoredBy: RightsSuspensionInsert["restoredBy"]; restoreReason: string; restoreAuditId: string }): Promise<RightsSuspension | null> =>
		refusing((reason) => new RightsSuspensionRefusedError(reason), async () =>
			(await db.update(rightsSuspensions).set({ endedAt: sql`now()`, ...input }).where(and(eq(rightsSuspensions.id, id), isNull(rightsSuspensions.endedAt))).returning())[0] ?? null),
});
