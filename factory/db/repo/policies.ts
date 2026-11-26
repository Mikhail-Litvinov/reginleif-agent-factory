import { desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { executionPolicies } from "../schema/execution-policies.ts";

type PolicyInsert = typeof executionPolicies.$inferInsert;
type Policy = typeof executionPolicies.$inferSelect;
type NewPolicy = Omit<PolicyInsert, "version">;

export const policyRepo = (db: PostgresJsDatabase<any>) => ({
	effective: async (projectId: string | null): Promise<Policy | undefined> => {
		if (projectId !== null) {
			const projectPolicy = (await db.select().from(executionPolicies).where(eq(executionPolicies.projectId, projectId)).orderBy(desc(executionPolicies.version)).limit(1))[0];
			if (projectPolicy) return projectPolicy;
		}
		return (await db.select().from(executionPolicies).where(isNull(executionPolicies.projectId)).orderBy(desc(executionPolicies.version)).limit(1))[0];
	},
	create: async (input: NewPolicy): Promise<Policy> => {
		const project = input.projectId ?? null;
		const latest = (await db.select({ version: executionPolicies.version }).from(executionPolicies).where(project === null ? isNull(executionPolicies.projectId) : eq(executionPolicies.projectId, project)).orderBy(desc(executionPolicies.version)).limit(1))[0];
		return (await db.insert(executionPolicies).values({ ...input, projectId: project, version: (latest?.version ?? 0) + 1 }).returning())[0]!;
	},
});

export type PolicyRepository = ReturnType<typeof policyRepo>;
