import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { apiFail, apiOk, SESSION_IO, SESSION_STOP_TIMEOUT } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore, requestSession, sessionLive, SESSION_POLL_MS, SESSION_TIMEOUTS } from "../session-core.js";

// A stop compacts the session first only when it holds more tokens than this. The threshold is rig's own; its origin is not recorded in this repo.
const STOP_COMPACT_TOKENS = 120_000;
// The stop waits at most this long (ms) for the session to end.
const STOP_TIMEOUT_MS = 15_000;

type Compact = { tokensBefore: number; tokensAfter: number } | { skip: string } | { error: string };
type StopResult = { session: string; stopped: false; reason: "not-running" } | { session: string; stopped: true; compacted: Compact | null };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const endSession = async (runtime: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok || !live.value) return live;
	if (session.pid === null) return apiOk(false);
	const killed = await runtime.process.killTree(session.pid);
	if (!killed.ok) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(killed.error));
	const deadline = runtime.clock.now().getTime() + STOP_TIMEOUT_MS;
	for (;;) {
		const current = await sessionLive(runtime, session);
		if (!current.ok) return current;
		if (!current.value) return apiOk(true);
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return apiFail(SESSION_STOP_TIMEOUT, messagesFor(runtime.language).session.stopTimeout());
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

export const stopSession = async (runtime: RuntimePorts, session: SessionRecord, progress: (event: ProgressEvent) => void): Promise<ApiResult<StopResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (!live.value) return apiOk({ session: session.id, stopped: false, reason: "not-running" });
	let compacted: Compact | null = null;
	const usage = await requestSession(runtime, session, "usage", {}, SESSION_TIMEOUTS.usage, progress);
	if (usage.ok && object(usage.value) && object(usage.value.context)) {
		const context = usage.value.context;
		const tokens = typeof context.tokens === "number" ? context.tokens : object(context.breakdown) && typeof context.breakdown.totalTokens === "number" ? context.breakdown.totalTokens : null;
		if (tokens !== null && tokens > STOP_COMPACT_TOKENS) {
			const compact = await compactSessionCore(runtime, session, undefined, progress);
			compacted = compact.ok ? compact.value : { error: compact.error.message };
		}
	}
	const stopped = await endSession(runtime, session);
	if (!stopped.ok) return stopped;
	return stopped.value ? apiOk({ session: session.id, stopped: true, compacted }) : apiOk({ session: session.id, stopped: false, reason: "not-running" });
};
