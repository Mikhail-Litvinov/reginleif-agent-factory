import { eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { routingRules } from "../schema/routing-rules.ts";

type RuleInsert = typeof routingRules.$inferInsert;
type Rule = typeof routingRules.$inferSelect;
type NewRule = Pick<RuleInsert, "id" | "position" | "match" | "preferredAgentIds"> & { projectId?: string | null };

export const routingRuleRepo = (db: PostgresJsDatabase<any>) => ({
	list: async (projectId: string | null): Promise<Rule[]> => db.select().from(routingRules)
		.where(projectId === null ? isNull(routingRules.projectId) : eq(routingRules.projectId, projectId)).orderBy(routingRules.position, routingRules.id),
	create: async (input: NewRule): Promise<Rule> => (await db.insert(routingRules).values({ ...input, projectId: input.projectId ?? null }).returning())[0]!,
});

export type RoutingRuleRepository = ReturnType<typeof routingRuleRepo>;
