import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
	key: text("key").primaryKey(), value: jsonb("value"), updatedBy: uuid("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
});
