import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { owners } from "./owners.ts";
import { workers } from "./workers.ts";

export const apiTokens = pgTable("api_tokens", {
	id: uuid("id").primaryKey(), name: text("name"), role: text("role"), ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "restrict" }),
	workerId: uuid("worker_id").references(() => workers.id, { onDelete: "restrict" }), prefix: text("prefix").unique(), tokenHash: text("token_hash"),
	createdBy: uuid("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp("expires_at", { withTimezone: true }), lastUsedAt: timestamp("last_used_at", { withTimezone: true }), revokedAt: timestamp("revoked_at", { withTimezone: true }),
	replacesTokenId: uuid("replaces_token_id"), validUntil: timestamp("valid_until", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [check("api_tokens_role", sql`${t.role} IN ('owner','worker','relay','reader')`), check("api_tokens_owner_binding", sql`${t.role} <> 'owner' OR ${t.ownerId} IS NOT NULL`), check("api_tokens_worker_binding", sql`${t.role} <> 'worker' OR ${t.workerId} IS NOT NULL`)]);
