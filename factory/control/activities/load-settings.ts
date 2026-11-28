import type { SettingsReader } from "../../db/repo/settings.ts";

// A pure read of the named settings; a replay sees the current values.
export const LoadSettings = (settings: SettingsReader, keys: readonly string[]): Promise<Record<string, unknown>> => settings.snapshot(keys);
