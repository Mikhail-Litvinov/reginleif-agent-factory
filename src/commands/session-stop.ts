import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";
import type { SessionEnding } from "../session-ending.js";

import { apiFail, apiOk, PROGRESS_CODE_SESSION_COMPACTING, PROGRESS_CODE_SESSION_TERMINATING, SESSION_IO, SESSION_STOP_TIMEOUT } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore, liveProcesses, lookupSession, requestSession, sessionLive, SESSION_POLL_MS, SESSION_TIMEOUTS } from "../session-core.js";
import { withSessionEnding } from "../session-ending.js";

// A stop compacts the session first only when it holds more tokens than this. The threshold is rig's own; its origin is not recorded in this repo.
const STOP_COMPACT_TOKENS = 120_000;
// The stop waits at most this long (ms) for the session to end.
const STOP_TIMEOUT_MS = 15_000;

type Compact = { tokensBefore: number; tokensAfter: number } | { skip: string } | { error: string };
type StopResult = { session: string; stopped: false; reason: "not-running" } | { session: string; stopped: true; compacted: Compact | null };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const endSession = async (runtime: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	// Every live process of the session is stopped, each only while its creation time still matches the record.
	const live = await liveProcesses(runtime, session);
	if (!live.ok) return live;
	if (live.value.length === 0) return apiOk(false);
	for (const process of live.value) {
		const killed = await runtime.process.killTree(process.pid);
		if (!killed.ok) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(killed.error));
	}
	const deadline = runtime.clock.now().getTime() + STOP_TIMEOUT_MS;
	for (;;) {
		const current = await liveProcesses(runtime, session);
		if (!current.ok) return current;
		if (current.value.length === 0) return apiOk(true);
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return apiFail(SESSION_STOP_TIMEOUT, messagesFor(runtime.language).session.stopTimeout());
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

// Used by mode while it holds ownership through both this stop and its following launch.
export const stopEndingSession = async (runtime: RuntimePorts, session: SessionRecord, progress: (event: ProgressEvent) => void, ending: SessionEnding): Promise<ApiResult<StopResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (!live.value) return apiOk({ session: session.id, stopped: false, reason: "not-running" });
	let compacted: Compact | null = null;
	const usage = await requestSession(runtime, session, "usage", {}, SESSION_TIMEOUTS.usage, progress);
	if (usage.ok && object(usage.value) && object(usage.value.context)) {
		const context = usage.value.context;
		const tokens = typeof context.tokens === "number" ? context.tokens : object(context.breakdown) && typeof context.breakdown.totalTokens === "number" ? context.breakdown.totalTokens : null;
		if (tokens !== null && tokens > STOP_COMPACT_TOKENS) {
			const takenOver = await ending.takenOver();
			if (!takenOver.ok) return takenOver;
			if (takenOver.value) compacted = { error: messagesFor(runtime.language).session.ended() };
			else {
				progress({ code: PROGRESS_CODE_SESSION_COMPACTING });
				const compact = await compactSessionCore(runtime, session, undefined, progress);
				compacted = compact.ok ? compact.value : { error: compact.error.message };
			}
		}
	}
	progress({ code: PROGRESS_CODE_SESSION_TERMINATING });
	const stopped = await endSession(runtime, session);
	if (!stopped.ok) return stopped;
	return stopped.value ? apiOk({ session: session.id, stopped: true, compacted }) : apiOk({ session: session.id, stopped: false, reason: "not-running" });
};

export const stopSession = (runtime: RuntimePorts, session: SessionRecord, progress: (event: ProgressEvent) => void): Promise<ApiResult<StopResult>> => withSessionEnding<StopResult>(runtime, session.id,
	(ending) => stopEndingSession(runtime, session, progress, ending),
	async (ownersLive) => {
		let stopped = false;
		let announced = false;
		const killCurrent = async (): Promise<ApiResult<boolean>> => {
			const current = await lookupSession(runtime, session.id);
			if (!current.ok) return current;
			const live = await sessionLive(runtime, current.value);
			if (!live.ok) return live;
			if (live.value && !announced) { announced = true; progress({ code: PROGRESS_CODE_SESSION_TERMINATING }); }
			return endSession(runtime, current.value);
		};
		// No elapsed-time limit: release or owner death ends this wait. The owner's steps are bounded:
		// compaction notices the kill within a poll; mode's registration wait is bounded to 90 seconds.
		for (;;) {
			const ended = await killCurrent();
			if (!ended.ok) return ended;
			stopped = ended.value || stopped;
			const live = await ownersLive();
			if (!live.ok) return live;
			if (!live.value) break;
			await runtime.clock.sleep(SESSION_POLL_MS);
		}
		const final = await killCurrent();
		if (!final.ok) return final;
		return stopped || final.value ? apiOk({ session: session.id, stopped: true, compacted: null }) : apiOk({ session: session.id, stopped: false, reason: "not-running" });
	},
);
