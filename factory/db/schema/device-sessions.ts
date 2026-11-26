import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices.ts";

export const deviceSessions = pgTable("device_sessions", {
	id: uuid("id").primaryKey(), deviceId: uuid("device_id").references(() => devices.id, { onDelete: "restrict" }),
	prefix: text("prefix").unique(), tokenHash: text("token_hash"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp("expires_at", { withTimezone: true }), lastUsedAt: timestamp("last_used_at", { withTimezone: true }), revokedAt: timestamp("revoked_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [index("device_sessions_live_device").on(t.deviceId).where(sql`${t.revokedAt} IS NULL`)]);
