import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { settings } from "../schema/settings.ts";
import { StaleVersionError, versionedUpdate } from "./errors.ts";

type SettingInsert = typeof settings.$inferInsert;
type Setting = typeof settings.$inferSelect;

export const settingsRepo = (db: PostgresJsDatabase<any>) => ({
	snapshot: async (keys: readonly string[]): Promise<Record<string, unknown>> => {
		if (keys.length === 0) return {};
		const rows = await db.select().from(settings).where(inArray(settings.key, [...keys]));
		return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
	},
	// Without a version the write is an upsert; with one it is a compare-and-set. Either the row is written
	// and returned, or StaleVersionError says the row is not at that version (changed or absent).
	set: async (key: string, value: unknown, updatedBy: string | null, expectedVersion?: bigint): Promise<Setting> => {
		if (expectedVersion === undefined) {
			const inserted: SettingInsert = { key, value, updatedBy };
			return (await db.insert(settings).values(inserted).onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedBy, updatedAt: new Date(), rowVersion: sql`${settings.rowVersion} + 1` },
			}).returning())[0]!;
		}
		const updated = await versionedUpdate({
			subject: ["setting", key].join(" "), expectedVersion,
			update: async () => (await db.update(settings).set({ value, updatedBy, updatedAt: new Date(), rowVersion: expectedVersion + 1n }).where(and(eq(settings.key, key), eq(settings.rowVersion, expectedVersion))).returning())[0],
			current: async () => (await db.select({ rowVersion: settings.rowVersion }).from(settings).where(eq(settings.key, key)).limit(1))[0],
		});
		if (!updated) throw new StaleVersionError(["setting", key].join(" "), expectedVersion);
		return updated;
	},
});

export type SettingsRepository = ReturnType<typeof settingsRepo>;
export type SettingsReader = Pick<SettingsRepository, "snapshot">;
