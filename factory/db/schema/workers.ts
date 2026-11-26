import { sql } from "drizzle-orm";
import { bigint, check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workers = pgTable("workers", {
	id: uuid("id").primaryKey(), machineId: text("machine_id").unique(), name: text("name"), platform: text("platform"),
	capabilities: jsonb("capabilities"), version: text("version"), contractVersion: integer("contract_version"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true }), status: text("status"), concurrencyLimit: integer("concurrency_limit"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [check("workers_status", sql`${t.status} IN ('online','offline','outdated','disabled')`)]);
