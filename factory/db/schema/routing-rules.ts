import { sql } from "drizzle-orm";
import { bigint, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const routingRules = pgTable("routing_rules", {
	id: uuid("id").primaryKey(), projectId: uuid("project_id"), position: integer("position"),
	match: jsonb("match"), preferredAgentIds: uuid("preferred_agent_ids").array(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
	rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
});
