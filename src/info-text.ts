import type { Messages } from "./messages.js";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const THOUSAND = 1000;
const MILLION = 1_000_000;
// The hub's STALE_LIMITS_MS: a limits block older than this says how old its data is.
export const STALE_LIMITS_MS = 300_000;
const FIVE_HOUR_KIND = "five_hour";
const SEVEN_DAY_KIND = "seven_day";
const LIMIT_ORDER = [FIVE_HOUR_KIND, SEVEN_DAY_KIND];
const MINUTES_KIND = /^(\d+)m$/;

export type Limit = { kind: string; percent: number; resetsAt: number | null };
export type ClaudeLimits = { at: number | null; limits: Limit[] };
export type CodexReading = { at: number; limits: Limit[] };
export type VolunteerReading = {
	at: number;
	dayPercent: number;
	resetsAt: number | null;
	providers: Array<{ name: string; used: number; cap: number }>;
};
// A source that failed carries the reason shown in its "no data" line.
export type Source<T> = { kind: "ok"; value: T } | { kind: "error"; reason: string };
export type ContextReading = {
	tokens: number | undefined;
	totalTokens: number | undefined;
	autoCompactEnabled: boolean;
	autoCompactThreshold: number | undefined;
};

// null: the block is not shown at all (feature off, account not allowed).
export type InfoInput = {
	claude: ClaudeLimits | null;
	codex: Source<CodexReading> | null;
	volunteers: Source<VolunteerReading> | null;
	context: ContextReading | null;
};

export const formatDuration = (milliseconds: number, messages: Messages): string => {
	const total = Math.max(1, Math.round(milliseconds / MS_PER_MINUTE));
	if (total < MINUTES_PER_HOUR) return `${total} ${messages.info.unitMinute()}`;
	const hours = Math.floor(total / MINUTES_PER_HOUR);
	const minutes = total % MINUTES_PER_HOUR;
	if (hours < HOURS_PER_DAY) {
		return minutes === 0 ? `${hours} ${messages.info.unitHour()}` : `${hours} ${messages.info.unitHour()} ${minutes} ${messages.info.unitMinute()}`;
	}
	const days = Math.floor(hours / HOURS_PER_DAY);
	const restHours = hours % HOURS_PER_DAY;
	return restHours === 0 ? `${days} ${messages.info.unitDay()}` : `${days} ${messages.info.unitDay()} ${restHours} ${messages.info.unitHour()}`;
};

const limitName = (kind: string, messages: Messages): string => {
	if (kind === FIVE_HOUR_KIND) return messages.info.limit5Hours();
	if (kind === SEVEN_DAY_KIND) return messages.info.limitWeek();
	const match = MINUTES_KIND.exec(kind);
	return match === null ? kind : formatDuration(Number(match[1]) * MS_PER_MINUTE, messages);
};

const formatTokens = (count: number): string =>
	count >= MILLION ? `${Number((count / MILLION).toFixed(1))}M` : `${Math.round(count / THOUSAND)}k`;

const orderOf = (kind: string): number => {
	const index = LIMIT_ORDER.indexOf(kind);
	return index === -1 ? LIMIT_ORDER.length : index;
};

// Array.prototype.sort is stable, so limits of the same rank keep their order.
const sortLimits = (limits: readonly Limit[]): Limit[] => [...limits].sort((a, b) => orderOf(a.kind) - orderOf(b.kind));

const staleAge = (at: number | null, now: number, messages: Messages): string | null => {
	const age = at === null ? 0 : now - at;
	return age >= STALE_LIMITS_MS ? formatDuration(age, messages) : null;
};

const resetSuffix = (resetsAt: number | null, now: number, messages: Messages): string =>
	resetsAt !== null && resetsAt - now > 0 ? messages.info.resetsIn(formatDuration(resetsAt - now, messages)) : "";

const limitLines = (limits: readonly Limit[], now: number, messages: Messages, codex: boolean): string[] =>
	sortLimits(limits).map((limit) => {
		// A Codex window whose reset has passed reads as unused; Claude's percent is shown as given.
		const passed = limit.resetsAt !== null && limit.resetsAt - now <= 0;
		const percent = codex ? (passed ? 0 : Math.round(limit.percent)) : limit.percent;
		return messages.info.limitLine(limitName(limit.kind, messages), percent) + resetSuffix(limit.resetsAt, now, messages);
	});

const volunteerLines = (reading: VolunteerReading, now: number, messages: Messages): string[] => {
	const resetsLeft = reading.resetsAt === null ? Number.NaN : reading.resetsAt - now;
	const day = resetsLeft > 0
		? messages.info.volunteerDay(Math.round(reading.dayPercent)) + messages.info.resetsIn(formatDuration(resetsLeft, messages))
		: messages.info.volunteerDay(0);
	return [
		messages.info.volunteerHeader(staleAge(reading.at, now, messages)),
		day,
		...reading.providers.map((provider) => `${provider.name}: ${provider.used}/${provider.cap}`),
	];
};

const contextLine = (context: ContextReading | null, messages: Messages): string => {
	if (context === null) return messages.info.noData();
	const used = context.tokens ?? context.totalTokens;
	if (used === undefined) return messages.info.noData();
	const estimate = context.tokens === undefined ? "≈" : "";
	if (context.autoCompactEnabled && context.autoCompactThreshold !== undefined) {
		return `${estimate}${Math.round(used / THOUSAND)}/${Math.round(context.autoCompactThreshold / THOUSAND)}k`;
	}
	return `${estimate}${formatTokens(used)}`;
};

// The finished text of /info: blocks in the hub's order, one empty line between them, only the headers in **bold**.
export const formatInfo = (input: InfoInput, now: number, messages: Messages): string => {
	const blocks: string[][] = [];
	blocks.push(input.claude === null || input.claude.limits.length === 0
		? [messages.info.claudeNoData()]
		: [messages.info.claudeHeader(staleAge(input.claude.at, now, messages)), ...limitLines(input.claude.limits, now, messages, false)]);
	if (input.codex !== null) {
		blocks.push(input.codex.kind === "error"
			? [messages.info.codexNoData(input.codex.reason)]
			: [messages.info.codexHeader(staleAge(input.codex.value.at, now, messages)), ...limitLines(input.codex.value.limits, now, messages, true)]);
	}
	if (input.volunteers !== null) {
		blocks.push(input.volunteers.kind === "error"
			? [messages.info.volunteerNoData(input.volunteers.reason)]
			: volunteerLines(input.volunteers.value, now, messages));
	}
	blocks.push([messages.info.contextHeader(), contextLine(input.context, messages)]);
	return blocks.map((block) => block.join("\n")).join("\n\n");
};
