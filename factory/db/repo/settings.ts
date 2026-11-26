import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { settings } from "../schema/settings.ts";

type SettingInsert = typeof settings.$inferInsert;
type Setting = typeof settings.$inferSelect;

export const settingsRepo = (db: PostgresJsDatabase<any>) => ({
	snapshot: async (keys: readonly string[]): Promise<Record<string, unknown>> => {
		if (keys.length === 0) return {};
		const rows = await db.select().from(settings).where(inArray(settings.key, [...keys]));
		return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
	},
	set: async (key: string, value: unknown, updatedBy: string | null, expectedVersion?: bigint): Promise<Setting | null> => {
		if (expectedVersion === undefined) {
			const inserted: SettingInsert = { key, value, updatedBy };
			return (await db.insert(settings).values(inserted).onConflictDoNothing({ target: settings.key }).returning())[0] ?? null;
		}
		return (await db.update(settings).set({ value, updatedBy, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(settings.key, key), eq(settings.rowVersion, expectedVersion))).returning())[0] ?? null;
	},
});

export type SettingsRepository = ReturnType<typeof settingsRepo>;
export type SettingsReader = Pick<SettingsRepository, "snapshot">;
