import type { FileSystem } from "./file-system.js";
import type { Language, Messages } from "./messages.js";
import type { Result } from "./result.js";

import { atomicWrite, joinPath, toSlashPath } from "./file-system.js";
import { DEFAULT_LANGUAGE, isLanguage, messagesFor } from "./messages.js";
import { err, errorText, ok } from "./result.js";

// A write-ahead journal of one `apply`. `entries` hold the record changes that count only when the file at `path`
// has the expected hash (`null` means the file is expected to be absent). `always` holds record changes that count
// unconditionally (a value of `null` deletes the record). `events` are sent after the final save; their ids are
// fixed when the journal is written, so a repeated send is recognised and skipped.
export type JournalEntry = { path: string; hash: string | null; records: Record<string, string | null> };
export type JournalEvent = { id: string; type: string; level: "info" | "warn" | "error"; text: string };
export type Journal = {
	entries: JournalEntry[];
	always: Record<string, string | null>;
	events: JournalEvent[];
};

export type RigState = {
	mode: "dev" | "server";
	paths: { repo: string; hub: string };
	features: Record<string, boolean>;
	records: Record<string, string>;
	badPairs: Array<{ repo: string; hub: string }>;
	pendingHubRestart: string | null;
	// Missing means English (DEFAULT_LANGUAGE).
	language?: Language;
	journal?: Journal;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isMissingFile = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
	isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
	isObject(value) && Object.values(value).every((entry) => typeof entry === "boolean");
const isBadPair = (value: unknown): value is { repo: string; hub: string } =>
	isObject(value) && typeof value.repo === "string" && typeof value.hub === "string";

const isNullableStringRecord = (value: unknown): value is Record<string, string | null> =>
	isObject(value) && Object.values(value).every((entry) => entry === null || typeof entry === "string");
const isJournalEntry = (value: unknown): value is JournalEntry =>
	isObject(value) && typeof value.path === "string" && (value.hash === null || typeof value.hash === "string") &&
	isNullableStringRecord(value.records);
const isJournalEvent = (value: unknown): value is JournalEvent =>
	isObject(value) && typeof value.id === "string" && typeof value.type === "string" && typeof value.text === "string" &&
	(value.level === "info" || value.level === "warn" || value.level === "error");
const isJournal = (value: unknown): value is Journal =>
	isObject(value) && isUnknownArray(value.entries) && value.entries.every(isJournalEntry) &&
	isNullableStringRecord(value.always) &&
	isUnknownArray(value.events) && value.events.every(isJournalEvent);

// `languageInvalid`: state.json holds a `language` value that is not a supported language. Every reader treats it as
// absent (English); only `rig language en|ru` needs to know, to write a valid value back.
export type StateReport = { state: RigState; languageInvalid: boolean };

export const parseStateReport = (text: string, messages: Messages): Result<StateReport> => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return err(messages.failure.stateInvalidJson());
	}
	if (!isObject(value) || (value.mode !== "dev" && value.mode !== "server") ||
		!isObject(value.paths) || typeof value.paths.repo !== "string" || typeof value.paths.hub !== "string" ||
		!isBooleanRecord(value.features) || !isStringRecord(value.records) ||
		!isUnknownArray(value.badPairs) || !value.badPairs.every(isBadPair) ||
		!(value.pendingHubRestart === null || typeof value.pendingHubRestart === "string") ||
		!(value.journal === undefined || isJournal(value.journal))) {
		return err(messages.failure.stateInvalidShape());
	}
	const state: RigState = {
		mode: value.mode,
		paths: { repo: toSlashPath(value.paths.repo), hub: toSlashPath(value.paths.hub) },
		features: value.features,
		records: value.records,
		badPairs: value.badPairs,
		pendingHubRestart: value.pendingHubRestart,
	};
	const languageInvalid = value.language !== undefined && !isLanguage(value.language);
	if (isLanguage(value.language)) state.language = value.language;
	if (value.journal !== undefined) state.journal = value.journal;
	return ok({ state, languageInvalid });
};

export const parseState = (text: string, messages: Messages): Result<RigState> => {
	const report = parseStateReport(text, messages);
	return report.ok ? ok(report.value.state) : report;
};

export const readState = async (fs: FileSystem, home: string, messages: Messages): Promise<Result<RigState>> => {
	try {
		return parseState(await fs.readText(joinPath(home, ".agent-rig", "state.json")), messages);
	} catch (error) {
		return err(messages.failure.stateReadFailed(errorText(error)));
	}
};

// null: there is no state.json (rig is not installed yet).
export const readStateReport = async (fs: FileSystem, home: string, messages: Messages): Promise<Result<StateReport | null>> => {
	let text: string;
	try {
		text = await fs.readText(joinPath(home, ".agent-rig", "state.json"));
	} catch (error) {
		return isMissingFile(error) ? ok(null) : err(messages.failure.stateReadFailed(errorText(error)));
	}
	return parseStateReport(text, messages);
};

// The language of everything rig prints: a missing, unreadable or invalid state.json, or an unsupported value in it,
// means the default language; the command itself reports a broken state later.
export const readStoredLanguage = async (fs: FileSystem, home: string): Promise<Language> => {
	const state = await readState(fs, home, messagesFor(DEFAULT_LANGUAGE));
	return state.ok ? state.value.language ?? DEFAULT_LANGUAGE : DEFAULT_LANGUAGE;
};

export const writeState = async (fs: FileSystem, home: string, state: RigState, messages: Messages): Promise<Result<void>> => {
	try {
		const result = await atomicWrite(fs, joinPath(home, ".agent-rig", "state.json"), `${JSON.stringify(state, null, 2)}\n`, messages);
		return result.ok ? ok(undefined) : err(messages.failure.stateWriteFailed(result.error));
	} catch (error) {
		return err(messages.failure.stateWriteFailed(errorText(error)));
	}
};
