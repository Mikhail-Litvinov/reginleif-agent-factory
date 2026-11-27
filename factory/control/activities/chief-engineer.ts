import type { SettingsReader } from '../../db/repo/settings.ts';

// No engineer activity runs in phase 2; callers supply the settings they need.
export const readChiefEngineerSettings = (settings: SettingsReader, keys: readonly string[]) => settings.snapshot(keys);
