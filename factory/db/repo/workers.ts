import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workers } from "../schema/workers.ts";

type WorkerInsert = typeof workers.$inferInsert;
type Worker = typeof workers.$inferSelect;
type RegisterWorker = Pick<WorkerInsert, "id" | "machineId" | "name" | "platform" | "capabilities" | "version" | "contractVersion" | "status" | "concurrencyLimit">;
type WorkerPatch = Partial<Omit<WorkerInsert, "id" | "machineId" | "createdAt" | "rowVersion">>;

export const workerRepo = (db: PostgresJsDatabase<any>) => ({
	list: async ({ status, platform }: { status?: string; platform?: string } = {}): Promise<Worker[]> => {
		const conditions: SQL[] = [];
		if (status !== undefined) conditions.push(eq(workers.status, status));
		if (platform !== undefined) conditions.push(eq(workers.platform, platform));
		return db.select().from(workers).where(and(...conditions)).orderBy(workers.name);
	},
	get: async (id: string): Promise<Worker | undefined> => (await db.select().from(workers).where(eq(workers.id, id)).limit(1))[0],
	register: async (input: RegisterWorker): Promise<Worker> => (await db.insert(workers).values({ ...input, lastSeenAt: new Date() }).onConflictDoUpdate({
		target: workers.machineId,
		set: { name: input.name, platform: input.platform, capabilities: input.capabilities, version: input.version, contractVersion: input.contractVersion, status: input.status, concurrencyLimit: input.concurrencyLimit, lastSeenAt: new Date(), updatedAt: new Date(), rowVersion: sql`${workers.rowVersion} + 1` },
	}).returning())[0]!,
	heartbeat: async (id: string, capabilities?: unknown, now = new Date()): Promise<Worker | null> =>
		(await db.update(workers).set({ ...(capabilities === undefined ? {} : { capabilities }), lastSeenAt: now, updatedAt: now, rowVersion: sql`${workers.rowVersion} + 1` }).where(eq(workers.id, id)).returning())[0] ?? null,
	update: async (id: string, expectedVersion: bigint, patch: WorkerPatch): Promise<Worker | null> =>
		(await db.update(workers).set({ ...patch, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(workers.id, id), eq(workers.rowVersion, expectedVersion))).returning())[0] ?? null,
});

export type WorkerRepository = ReturnType<typeof workerRepo>;
