import { and, eq, ilike, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects } from "../schema/projects.ts";

type ProjectInsert = typeof projects.$inferInsert;
type Project = typeof projects.$inferSelect;
type ProjectPatch = Partial<Omit<ProjectInsert, "id" | "createdAt" | "rowVersion" | "deletedAt">>;

export const projectRepo = (db: PostgresJsDatabase<any>) => ({
	list: async ({ includeDeleted = false, archived, q }: { includeDeleted?: boolean; archived?: boolean; q?: string } = {}): Promise<Project[]> => {
		const conditions: SQL[] = [];
		if (!includeDeleted) conditions.push(isNull(projects.deletedAt));
		if (archived === true) conditions.push(isNotNull(projects.archivedAt));
		if (archived === false) conditions.push(isNull(projects.archivedAt));
		if (q !== undefined) conditions.push(ilike(projects.name, `%${q}%`));
		return db.select().from(projects).where(and(...conditions)).orderBy(projects.name);
	},
	get: async (id: string, { includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<Project | undefined> =>
		(await db.select().from(projects).where(and(eq(projects.id, id), ...(includeDeleted ? [] : [isNull(projects.deletedAt)]))).limit(1))[0],
	create: async (input: ProjectInsert): Promise<Project> => (await db.insert(projects).values(input).returning())[0]!,
	update: async (id: string, expectedVersion: bigint, patch: ProjectPatch): Promise<Project | null> =>
		(await db.update(projects).set({ ...patch, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(projects.id, id), eq(projects.rowVersion, expectedVersion), isNull(projects.deletedAt))).returning())[0] ?? null,
	archive: async (id: string, expectedVersion: bigint): Promise<Project | null> =>
		(await db.update(projects).set({ archivedAt: new Date(), updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(projects.id, id), eq(projects.rowVersion, expectedVersion), isNull(projects.deletedAt))).returning())[0] ?? null,
});

export type ProjectRepository = ReturnType<typeof projectRepo>;
