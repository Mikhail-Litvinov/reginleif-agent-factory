import { sql } from "drizzle-orm";
import { bigint, check, customType, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });
export const auditLog = pgTable("audit_log", {
	id: uuid("id").primaryKey(), seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull().unique(),
	commitXid: xid8("commit_xid").notNull().default(sql`pg_current_xact_id()`), actorId: uuid("actor_id"),
	tokenId: uuid("token_id"), requestId: uuid("request_id"), action: text("action"),
	targetType: text("target_type"), targetId: uuid("target_id"), outcome: text("outcome"), requestHash: text("request_hash"),
	details: jsonb("details"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_log_cursor").on(t.commitXid, t.seq), check("audit_log_outcome", sql`${t.outcome} IN ('ok','denied','failed','needs_confirmation')`)]);
