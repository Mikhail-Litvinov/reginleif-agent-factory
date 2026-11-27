import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { taskRuns } from "../schema/runs.ts";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { apiTokens } from "../schema/api-tokens.ts";
import { versionedUpdate } from "./errors.ts";

type TokenInsert = typeof apiTokens.$inferInsert;
type Token = typeof apiTokens.$inferSelect;
type ListedToken = Omit<Token, "tokenHash">;
type NewToken = Omit<TokenInsert, "rowVersion" | "updatedAt" | "lastUsedAt" | "revokedAt" | "validUntil" | "replacesTokenId"> & Partial<Pick<TokenInsert, "validUntil" | "replacesTokenId">>;

export const tokenRepo = (db: PostgresJsDatabase<any>) => ({
	revokeForStop: async (agentIds: string[], sessionRefs: string[]): Promise<void> => {
		if (agentIds.length === 0 && sessionRefs.length === 0) return;
		await db.update(apiTokens).set({ revokedAt: sql`now()`, updatedAt: sql`now()`, rowVersion: sql`${apiTokens.rowVersion} + 1` })
			.where(and(isNull(apiTokens.revokedAt), or(
				agentIds.length ? inArray(apiTokens.runId, db.select({ id: taskRuns.id }).from(taskRuns).where(inArray(taskRuns.agentId, agentIds))) : undefined,
				sessionRefs.length ? inArray(apiTokens.sessionRef, sessionRefs) : undefined,
			)));
	},
	list: async (): Promise<ListedToken[]> => db.select({ id: apiTokens.id, name: apiTokens.name, role: apiTokens.role, ownerId: apiTokens.ownerId, workerId: apiTokens.workerId, sessionRef: apiTokens.sessionRef, runId: apiTokens.runId, prefix: apiTokens.prefix, createdBy: apiTokens.createdBy, createdAt: apiTokens.createdAt, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt, revokedAt: apiTokens.revokedAt, replacesTokenId: apiTokens.replacesTokenId, validUntil: apiTokens.validUntil, updatedAt: apiTokens.updatedAt, rowVersion: apiTokens.rowVersion }).from(apiTokens).orderBy(apiTokens.createdAt, apiTokens.id),
	get: async (id: string): Promise<Token | undefined> => (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1))[0],
	byHash: async (tokenHash: string): Promise<Token | undefined> => (await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).limit(1))[0],
	create: async (input: NewToken): Promise<Token> => (await db.insert(apiTokens).values(input).returning())[0]!,
	rotate: async (id: string, expectedVersion: bigint, replacement: NewToken, validUntil: Date): Promise<Token | null> => db.transaction(async (tx) => {
		const old = await versionedUpdate({
			subject: ["token", id].join(" "), expectedVersion,
			update: async () => (await tx.update(apiTokens).set({ validUntil, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(apiTokens.id, id), eq(apiTokens.rowVersion, expectedVersion), isNull(apiTokens.revokedAt))).returning())[0],
			current: async () => (await tx.select({ rowVersion: apiTokens.rowVersion }).from(apiTokens).where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt))).limit(1))[0],
		});
		if (!old) return null;
		return (await tx.insert(apiTokens).values({ ...replacement, replacesTokenId: id, validUntil: null }).returning())[0]!;
	}),
	revoke: async (id: string, expectedVersion: bigint): Promise<Token | null> => versionedUpdate({
		subject: ["token", id].join(" "), expectedVersion,
		update: async () => (await db.update(apiTokens).set({ revokedAt: new Date(), updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(apiTokens.id, id), eq(apiTokens.rowVersion, expectedVersion), isNull(apiTokens.revokedAt))).returning())[0],
		current: async () => (await db.select({ rowVersion: apiTokens.rowVersion }).from(apiTokens).where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt))).limit(1))[0],
	}),
});

export type TokenRepository = ReturnType<typeof tokenRepo>;
