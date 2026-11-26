import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { owners } from "./owners.ts";

export const devices = pgTable("devices", {
	id: uuid("id").primaryKey(), ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "restrict" }),
	name: text("name"), platform: text("platform"), codeHash: text("code_hash"),
	codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }), codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), revokedAt: timestamp("revoked_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [check("devices_platform", sql`${t.platform} IN ('android','windows')`)]);
