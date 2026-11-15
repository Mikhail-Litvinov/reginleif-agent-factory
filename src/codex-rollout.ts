import type { FileSystem } from "./file-system.js";
import type { CodexLimit, CodexReading } from "./info-data.js";

import { joinPath } from "./file-system.js";
import { isoOrNull } from "./info-data.js";

// Codex writes `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`; the newest rollout with a rate-limit event wins.
// Same limits as the hub's reader: at most this many files, looked at from the newest date directory down.
const MAX_FILES = 20;
// Rollouts grow to many MB, so they are read backwards in blocks of this size (the hub's reader used 64 KiB too).
export const TAIL_BLOCK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;
const NO_NEWLINE = -1;
const MS_PER_SECOND = 1000;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;
const RATE_LIMITS_MARKER = "\"rate_limits\"";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toLimit = (window: unknown): CodexLimit | null => {
	if (!isRecord(window)) return null;
	const { used_percent: used, window_minutes: minutes, resets_at: resets } = window;
	if (typeof used !== "number" || !(used >= 0)) return null;
	if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) return null;
	if (resets !== undefined && (typeof resets !== "number" || !Number.isFinite(resets))) return null;
	return { windowMinutes: minutes, usedPercent: used, resetsAt: resets === undefined ? null : isoOrNull(resets * MS_PER_SECOND) };
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
	const iso = isoOrNull(at);
	return limits.length === 0 || iso === null ? null : { at: iso, limits };
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

type Rollout = { path: string; size: number; mtimeMs: number };

// Newest first: by modification time (a resumed old session is written to after newer ones), then by name.
const newestRolloutFirst = (a: Rollout, b: Rollout): number => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path);

const newestNameFirst = (a: string, b: string): number => b.localeCompare(a);

const concatBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
	const joined = new Uint8Array(first.length + second.length);
	joined.set(first, 0);
	joined.set(second, first.length);
	return joined;
};

const rolloutFiles = async (fs: FileSystem, directory: string, depth: number): Promise<Rollout[]> => {
	let entries: Array<{ name: string; directory: boolean }>;
	try {
		entries = await fs.listDirectory(directory);
	} catch {
		return [];
	}
	const part = DATE_PARTS[depth];
	if (part === undefined) {
		const paths = entries.filter((entry) => !entry.directory && ROLLOUT_NAME.test(entry.name)).map((entry) => joinPath(directory, entry.name));
		const stats = await Promise.all(paths.map(async (path) => {
			try {
				return { path, stat: await fs.stat(path) };
			} catch {
				return { path, stat: null };
			}
		}));
		const found: Rollout[] = stats.flatMap(({ path, stat }) => stat === null ? [] : [{ path, size: stat.size, mtimeMs: stat.mtimeMs }]);
		return found.sort(newestRolloutFirst).slice(0, MAX_FILES);
	}
	const files: Rollout[] = [];
	for (const name of entries.filter((entry) => entry.directory && part.test(entry.name)).map((entry) => entry.name).sort(newestNameFirst)) {
		files.push(...await rolloutFiles(fs, joinPath(directory, name), depth + 1));
		if (files.length >= MAX_FILES) break;
	}
	return files.slice(0, MAX_FILES);
};

// The last rate-limit event of a file, found by reading blocks from the end until a line matches; a file is never read
// whole. A line cut by a block boundary is carried over and completed by the next (earlier) block, so a line longer
// than a block still parses. Cutting at a newline byte is safe in UTF-8: no multi-byte character contains one.
const readLastReading = async (fs: FileSystem, rollout: Rollout): Promise<CodexReading | null> => {
	let end = rollout.size;
	let carry: Uint8Array = new Uint8Array(0);
	while (end > 0) {
		const start = Math.max(0, end - TAIL_BLOCK_BYTES);
		const joined = concatBytes(await fs.readRange(rollout.path, start, end - start), carry);
		const firstNewline = start === 0 ? NO_NEWLINE : joined.indexOf(NEWLINE_BYTE);
		if (start > 0 && firstNewline === NO_NEWLINE) {
			carry = joined;
			end = start;
			continue;
		}
		const complete = start === 0 ? joined : joined.subarray(firstNewline + 1);
		const reading = parseRolloutLimits(new TextDecoder().decode(complete));
		if (reading !== null) return reading;
		carry = start === 0 ? new Uint8Array(0) : joined.subarray(0, firstNewline);
		end = start;
	}
	return null;
};

export const readCodexLimits = async (fs: FileSystem, codexHome: string): Promise<CodexReading | null> => {
	for (const rollout of await rolloutFiles(fs, joinPath(codexHome, "sessions"), 0)) {
		try {
			const reading = await readLastReading(fs, rollout);
			if (reading !== null) return reading;
		} catch {
			// An unreadable rollout is skipped; the next one may have a reading.
		}
	}
	return null;
};
