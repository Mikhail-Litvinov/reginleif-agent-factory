import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects } from "../schema/projects.ts";
import { versionedUpdate } from "./errors.ts";

type ProjectInsert = typeof projects.$inferInsert;
type Project = typeof projects.$inferSelect;
type ProjectPatch = Partial<Omit<ProjectInsert, "id" | "createdAt" | "rowVersion" | "deletedAt">>;

export const projectRepo = (db: PostgresJsDatabase<any>) => ({
	list: async ({ includeDeleted = false, archived, q }: { includeDeleted?: boolean; archived?: boolean; q?: string } = {}): Promise<Project[]> => {
		const conditions: SQL[] = [];
		if (!includeDeleted) conditions.push(isNull(projects.deletedAt));
		if (archived === true) conditions.push(isNotNull(projects.archivedAt));
		if (archived === false) conditions.push(isNull(projects.archivedAt));
		// Plain substring match: strpos reads % and _ in the search text literally (LIKE would treat them as wildcards).
		if (q !== undefined) conditions.push(sql`strpos(lower(${projects.name}), lower(${q}::text)) > 0`);
		return db.select().from(projects).where(and(...conditions)).orderBy(projects.name);
	},
	get: async (id: string, { includeDeleted = false, lock = false }: { includeDeleted?: boolean; lock?: boolean } = {}): Promise<Project | undefined> => {
		const query = db.select().from(projects).where(and(eq(projects.id, id), ...(includeDeleted ? [] : [isNull(projects.deletedAt)]))).limit(1);
		return (await (lock ? query.for("update") : query))[0];
	},
	create: async (input: ProjectInsert): Promise<Project> => (await db.insert(projects).values(input).returning())[0]!,
	update: async (id: string, expectedVersion: bigint, patch: ProjectPatch): Promise<Project | null> => versionedUpdate({
		subject: ["project", id].join(" "), expectedVersion,
		update: async () => (await db.update(projects).set({ ...patch, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(projects.id, id), eq(projects.rowVersion, expectedVersion), isNull(projects.deletedAt))).returning())[0],
		current: async () => (await db.select({ rowVersion: projects.rowVersion }).from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1))[0],
	}),
	archive: async (id: string, expectedVersion: bigint): Promise<Project | null> => versionedUpdate({
		subject: ["project", id].join(" "), expectedVersion,
		update: async () => (await db.update(projects).set({ archivedAt: new Date(), updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(projects.id, id), eq(projects.rowVersion, expectedVersion), isNull(projects.deletedAt))).returning())[0],
		current: async () => (await db.select({ rowVersion: projects.rowVersion }).from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1))[0],
	}),
});

export type ProjectRepository = ReturnType<typeof projectRepo>;
