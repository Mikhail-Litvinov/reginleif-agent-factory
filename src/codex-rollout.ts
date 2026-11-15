import type { FileSystem } from "./file-system.js";
import type { CodexReading, Limit } from "./info-text.js";

import { joinPath } from "./file-system.js";

// Codex writes `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`; the newest rollout with a rate-limit event wins.
// Same limits as the hub's reader: at most this many files, looked at from the newest date directory down.
const MAX_FILES = 20;
const MS_PER_SECOND = 1000;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;
const RATE_LIMITS_MARKER = "\"rate_limits\"";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toLimit = (window: unknown): Limit | null => {
	if (!isRecord(window)) return null;
	const { used_percent: used, window_minutes: minutes, resets_at: resets } = window;
	if (typeof used !== "number" || !(used >= 0)) return null;
	if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) return null;
	if (resets !== undefined && (typeof resets !== "number" || !Number.isFinite(resets))) return null;
	const kind = minutes === FIVE_HOUR_MINUTES ? "five_hour" : minutes === SEVEN_DAY_MINUTES ? "seven_day" : `${minutes}m`;
	return { kind, percent: used, resetsAt: resets === undefined ? null : resets * MS_PER_SECOND };
};

const parseLine = (line: string): CodexReading | null => {
	if (!line.includes(RATE_LIMITS_MARKER)) return null;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(event) || event.type !== "event_msg" || typeof event.timestamp !== "string") return null;
	const at = Date.parse(event.timestamp);
	const payload = event.payload;
	if (!Number.isFinite(at) || !isRecord(payload) || payload.type !== "token_count") return null;
	const rateLimits = payload.rate_limits;
	if (!isRecord(rateLimits) || rateLimits.limit_id !== "codex") return null;
	const limits = [rateLimits.primary, rateLimits.secondary].flatMap((window) => {
		const limit = toLimit(window);
		return limit === null ? [] : [limit];
	});
	return limits.length === 0 ? null : { at, limits };
};

// The last parsable rate-limit event of a rollout, or null.
export const parseRolloutLimits = (text: string): CodexReading | null => {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const reading = parseLine(lines[index]);
		if (reading !== null) return reading;
	}
	return null;
};

const newestFirst = (a: string, b: string): number => b.localeCompare(a);

const rolloutFiles = async (fs: FileSystem, directory: string, depth: number): Promise<string[]> => {
	let entries: Array<{ name: string; directory: boolean }>;
	try {
		entries = await fs.listDirectory(directory);
	} catch {
		return [];
	}
	const part = DATE_PARTS[depth];
	if (part === undefined) {
		// Rollout names start with their start time, so the name order is the age order.
		return entries
			.filter((entry) => !entry.directory && ROLLOUT_NAME.test(entry.name))
			.map((entry) => joinPath(directory, entry.name))
			.sort(newestFirst)
			.slice(0, MAX_FILES);
	}
	const files: string[] = [];
	for (const name of entries.filter((entry) => entry.directory && part.test(entry.name)).map((entry) => entry.name).sort(newestFirst)) {
		files.push(...await rolloutFiles(fs, joinPath(directory, name), depth + 1));
		if (files.length >= MAX_FILES) break;
	}
	return files.slice(0, MAX_FILES);
};

export const readCodexLimits = async (fs: FileSystem, codexHome: string): Promise<CodexReading | null> => {
	for (const path of await rolloutFiles(fs, joinPath(codexHome, "sessions"), 0)) {
		try {
			const reading = parseRolloutLimits(await fs.readText(path));
			if (reading !== null) return reading;
		} catch {
			// An unreadable rollout is skipped; the next one may have a reading.
		}
	}
	return null;
};
