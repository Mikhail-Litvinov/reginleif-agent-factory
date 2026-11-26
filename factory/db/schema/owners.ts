import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const owners = pgTable("owners", {
	id: uuid("id").primaryKey(),
	name: text("name"),
	telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).unique(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	disabledAt: timestamp("disabled_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
});
