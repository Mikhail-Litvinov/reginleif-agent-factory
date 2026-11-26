import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { routingRules } from "../schema/routing-rules.ts";

type RuleInsert = typeof routingRules.$inferInsert;
type Rule = typeof routingRules.$inferSelect;
type NewRule = Pick<RuleInsert, "id" | "position" | "match" | "preferredAgentIds"> & { projectId?: string | null };

export const routingRuleRepo = (db: PostgresJsDatabase<any>) => ({
	list: async (projectId: string | null, { includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<Rule[]> => db.select().from(routingRules)
		.where(and(projectId === null ? isNull(routingRules.projectId) : eq(routingRules.projectId, projectId), ...(includeDeleted ? [] : [isNull(routingRules.deletedAt)]))).orderBy(routingRules.position, routingRules.id),
	create: async (input: NewRule): Promise<Rule> => (await db.insert(routingRules).values({ ...input, projectId: input.projectId ?? null }).returning())[0]!,
	delete: async (id: string): Promise<Rule | null> =>
		(await db.update(routingRules).set({ deletedAt: new Date(), updatedAt: new Date(), rowVersion: sql`${routingRules.rowVersion} + 1` }).where(and(eq(routingRules.id, id), isNull(routingRules.deletedAt))).returning())[0] ?? null,
});

export type RoutingRuleRepository = ReturnType<typeof routingRuleRepo>;
