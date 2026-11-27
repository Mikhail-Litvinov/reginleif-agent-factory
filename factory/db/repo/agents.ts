import { and, eq, ilike, isNull, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agents } from "../schema/agents.ts";
import { versionedUpdate } from "./errors.ts";

type AgentInsert = typeof agents.$inferInsert;
type Agent = typeof agents.$inferSelect;
type AgentPatch = Partial<Omit<AgentInsert, "id" | "createdAt" | "rowVersion" | "deletedAt">>;

export const agentRepo = (db: PostgresJsDatabase<any>) => ({
	list: async ({ includeDeleted = false, provider, enabled }: { includeDeleted?: boolean; provider?: string; enabled?: boolean } = {}): Promise<Agent[]> => {
		const conditions: SQL[] = [];
		if (!includeDeleted) conditions.push(isNull(agents.deletedAt));
		if (provider !== undefined) conditions.push(eq(agents.provider, provider));
		if (enabled !== undefined) conditions.push(eq(agents.enabled, enabled));
		return db.select().from(agents).where(and(...conditions)).orderBy(agents.name);
	},
	get: async (id: string, { includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<Agent | undefined> =>
		(await db.select().from(agents).where(and(eq(agents.id, id), ...(includeDeleted ? [] : [isNull(agents.deletedAt)]))).limit(1))[0],
	create: async (input: AgentInsert): Promise<Agent> => (await db.insert(agents).values(input).returning())[0]!,
	update: async (id: string, expectedVersion: bigint, patch: AgentPatch): Promise<Agent | null> => versionedUpdate({
		subject: ["agent", id].join(" "), expectedVersion,
		update: async () => (await db.update(agents).set({ ...patch, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(agents.id, id), eq(agents.rowVersion, expectedVersion), isNull(agents.deletedAt))).returning())[0],
		current: async () => (await db.select({ rowVersion: agents.rowVersion }).from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1))[0],
	}),
	softDelete: async (id: string, expectedVersion: bigint): Promise<Agent | null> => versionedUpdate({
		subject: ["agent", id].join(" "), expectedVersion,
		update: async () => (await db.update(agents).set({ deletedAt: new Date(), updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(agents.id, id), eq(agents.rowVersion, expectedVersion), isNull(agents.deletedAt))).returning())[0],
		current: async () => (await db.select({ rowVersion: agents.rowVersion }).from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1))[0],
	}),
});

export type AgentRepository = ReturnType<typeof agentRepo>;
