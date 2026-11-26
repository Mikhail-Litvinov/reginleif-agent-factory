import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
	id: uuid("id").primaryKey(), name: text("name"), provider: text("provider"), adapterType: text("adapter_type"),
	capabilities: jsonb("capabilities"), enabled: boolean("enabled"), concurrencyLimit: integer("concurrency_limit"), configuration: jsonb("configuration"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	deletedAt: timestamp("deleted_at", { withTimezone: true }), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [uniqueIndex("agents_live_name").on(t.name).where(sql`${t.deletedAt} IS NULL`)]);
