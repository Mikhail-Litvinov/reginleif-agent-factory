import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { owners } from "../schema/owners.ts";

type Owner = typeof owners.$inferSelect;

export const ownerRepo = (db: PostgresJsDatabase<any>) => ({
	// An owner that is not disabled; a disabled or unknown id gives undefined.
	activeById: async (id: string): Promise<Owner | undefined> => (await db.select().from(owners).where(and(eq(owners.id, id), isNull(owners.disabledAt))).limit(1))[0],
	byTelegramUserId: async (telegramUserId: bigint): Promise<Owner | undefined> => (await db.select().from(owners).where(and(eq(owners.telegramUserId, telegramUserId), isNull(owners.disabledAt))).limit(1))[0],
});

export type OwnerRepository = ReturnType<typeof ownerRepo>;
