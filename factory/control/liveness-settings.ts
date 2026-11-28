// Settings of the machine liveness check (package 57, MachineLivenessWorkflow). They are not activity timeouts, so they are
// not in the ActivityCatalog. No default is set here: an absent or non-positive value is an error, and the Control Worker
// does not start (factory/control/worker.ts), the same rule as for `act.*`. The values are in database.md, settings table.
export const LIVENESS_INTERVAL_KEY = "liveness.intervalSeconds";
export const LIVENESS_SILENCE_KEY = "liveness.silenceSeconds";
export const LIVENESS_SETTING_KEYS: readonly string[] = [LIVENESS_INTERVAL_KEY, LIVENESS_SILENCE_KEY];

/** The liveness keys that are absent or not a positive number of seconds (all of them, not the first). */
export const invalidLivenessKeys = (snapshot: Readonly<Record<string, unknown>>): string[] =>
	LIVENESS_SETTING_KEYS.filter((key) => {
		const value = snapshot[key];
		return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
	});

/** One problem line naming the invalid liveness keys, or none. */
export const livenessSettingsProblems = (snapshot: Readonly<Record<string, unknown>>): string[] => {
	const invalid = invalidLivenessKeys(snapshot);
	return invalid.length > 0 ? [`unset or invalid settings: ${invalid.join(", ")}`] : [];
};
