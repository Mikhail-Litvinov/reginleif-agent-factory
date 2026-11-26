import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { auditLog } from "../schema/audit-log.ts";

type AuditInsert = typeof auditLog.$inferInsert;
type AuditRow = typeof auditLog.$inferSelect;
type AuditInput = Omit<AuditInsert, "seq" | "commitXid" | "createdAt">;
// below: an xid8 as text; only rows whose commit_xid is smaller are listed. Production callers take it from snapshotXmin().
export interface AuditFilter { actorId?: string; action?: string; targetId?: string; limit?: number; after?: { commitXid: string; seq: bigint }; below: string }

export const auditRepo = (db: PostgresJsDatabase<any>) => ({
	append: async (input: AuditInput): Promise<AuditRow> => (await db.insert(auditLog).values(input).returning())[0]!,
	// xids are cluster-wide: an open transaction in another database holds this value down, so it is read per call, not fixed.
	snapshotXmin: async (): Promise<string> => (await db.execute<{ xmin: string }>(sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`))[0]!.xmin,
	list: async ({ actorId, action, targetId, limit, after, below }: AuditFilter): Promise<AuditRow[]> => {
		const conditions: SQL[] = [];
		if (actorId !== undefined) conditions.push(eq(auditLog.actorId, actorId));
		if (action !== undefined) conditions.push(eq(auditLog.action, action));
		if (targetId !== undefined) conditions.push(eq(auditLog.targetId, targetId));
		conditions.push(sql`${auditLog.commitXid} < ${below}::xid8`);
		if (after) conditions.push(or(gt(auditLog.commitXid, sql`${after.commitXid}::xid8`), and(eq(auditLog.commitXid, sql`${after.commitXid}::xid8`), gt(auditLog.seq, after.seq)))!);
		const query = db.select().from(auditLog).where(and(...conditions)).orderBy(asc(auditLog.commitXid), asc(auditLog.seq));
		return limit === undefined ? query : query.limit(limit);
	},
});

export type AuditRepository = ReturnType<typeof auditRepo>;
