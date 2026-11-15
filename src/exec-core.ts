import type { ApiResult, JsonValue } from "./output.js";
import type { RuntimePorts, StreamingRun } from "./ports.js";
import type { Result } from "./result.js";

import { ID_PATTERN } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import { cleanEnvironment } from "./clean-environment.js";
import { atomicWrite, joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, EXEC_BAD_ID, EXEC_INVALID, EXEC_IO, EXEC_LAUNCH, EXEC_UNAVAILABLE, EXEC_UNKNOWN } from "./output.js";
import { err, errorText } from "./result.js";
import { readState } from "./state.js";

// The runner rewrites its heartbeat file this often (ms); the age of that file is how status judges a run is still alive.
export const EXEC_HEARTBEAT_MS = 10_000;
// A heartbeat this old (three intervals) is stale: a run is `lost` only when its runner is gone too; with a live runner it stays `running`.
export const EXEC_STALE_MS = 3 * EXEC_HEARTBEAT_MS;
// Ended runs kept on disk: a start prunes the oldest beyond this; running runs are never pruned. The value is the retention rig-exec-design.md sets.
export const EXEC_MAX_RUNS = 50;
// One status response carries at most this many log bytes (64 KiB), so its size stays bounded whatever the log size; the caller polls for the rest.
export const EXEC_LOG_CHUNK_BYTES = 64 * 1024;
// How often a status call with `--wait` checks the log and the end. New output reaches the caller at most this late; each
// check reads the heartbeat and stats the log (and reads its bytes). 250 ms bounds the delay under a quarter second against
// about four small checks a second per waiting call, which a poll of 20 to 30 seconds does not notice.
export const EXEC_WAIT_POLL_MS = 250;
// Keep startup diagnostics bounded to the same 64 KiB diagnostic budget independently of log paging.
const EXEC_RUNNER_STDERR_LIMIT = 64 * 1024;
// How often the runner checks whether a run still holds a process after its command has exited. The wait for the last
// process is not busy: this bounds the delay of the recorded end (at most this long after the last process is gone)
// against the cost of a check (one `ps` start per check on POSIX); one second is far below the heartbeat interval.
export const EXEC_RUN_POLL_MS = 1_000;
// How long a stop request may wait for the runner to act on it before `stop` kills the run from outside (a hung runner):
// one poll to see the request, one poll to see the killed members gone, the bounded output drain (2 s, OUTPUT_DRAIN_MS in
// real-runtime.ts) before the end is written, and a poll of slack.
export const EXEC_STOP_GRACE_MS = 5 * EXEC_RUN_POLL_MS;
// The reason of an end the runner records after its checks (stop request, member count) failed for the whole stale window.
export const EXEC_CHECK_FAILED_REASON = "run-check-failed";
// Exit code of a failed runner, and the reason of the last-resort end recorded when the end itself cannot be written.
const EXEC_RUNNER_FAILED_CODE = 1;
const EXEC_END_WRITE_FAILED = "end-write-failed";
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_PREFIX = 0x80;
const UTF8_TWO_BYTE_MIN = 0xc2;
const UTF8_TWO_BYTE_MAX = 0xdf;
const UTF8_THREE_BYTE_MIN = 0xe0;
const UTF8_THREE_BYTE_MAX = 0xef;
const UTF8_FOUR_BYTE_MIN = 0xf0;
const UTF8_FOUR_BYTE_MAX = 0xf4;
const UTF8_TWO_BYTES = 2;
const UTF8_THREE_BYTES = 3;
const UTF8_FOUR_BYTES = 4;

export type ExecShell = "pwsh" | "cmd" | "bash";
export type ShellLaunch = { argv: string[]; env: Record<string, string>; files: { path: string; bytes: Uint8Array }[]; verbatimArguments?: boolean };
export type ShellBuilder = (runtime: RuntimePorts, shell: ExecShell, text: string, runDir: string) => Promise<ApiResult<ShellLaunch>>;
type ShellRecord = { id: string; shell: ExecShell; cwd: string; text: string; startedAt: string };
type RigRecord = { id: string; shell: "rig"; args: string[]; startedAt: string };
type RecordData = ShellRecord | RigRecord;
type Identity = { pid: number; pidCreated: string };
type End = { kind: "exit" | "stopped" | "lost"; code: number | null; at: string; reason?: string };
type Summary = { id: string; shell: ExecShell; cwd: string; state: "running" | "ended"; startedAt: string; end?: End } | { id: string; shell: "rig"; args: string[]; state: "running" | "ended"; startedAt: string; end?: End };
// Commands a `rig` run refuses: no recursion into exec, no internal commands.
const EXEC_RIG_REFUSED = new Set(["exec", "exec-runner", "update-step"]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shellValue = (value: unknown): value is ExecShell => value === "pwsh" || value === "cmd" || value === "bash";
const root = (r: RuntimePorts): string => joinPath(r.home, ".agent-rig", "exec");
const dir = (r: RuntimePorts, id: string): string => joinPath(root(r), id);
const file = (r: RuntimePorts, id: string, name: string): string => joinPath(dir(r, id), name);
const missing = (error: unknown): boolean => object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
const io = (r: RuntimePorts, error: unknown): ApiResult<never> => apiFail(EXEC_IO, messagesFor(r.language).exec.io(errorText(error)));
const validRecord = (value: unknown, id: string): value is RecordData => object(value) && value.id === id && typeof value.startedAt === "string" && (value.shell === "rig"
	? Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")
	: shellValue(value.shell) && typeof value.cwd === "string" && typeof value.text === "string");
const rigHome = (r: RuntimePorts): string => joinPath(r.home, ".agent-rig");
const validEnd = (value: unknown): value is End => object(value) && (value.kind === "exit" || value.kind === "stopped" || value.kind === "lost") && (value.code === null || (typeof value.code === "number" && Number.isInteger(value.code))) && typeof value.at === "string" && (value.reason === undefined || typeof value.reason === "string");
const validIdentity = (value: unknown): value is Identity => object(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.pidCreated === "string" && value.pidCreated.length > 0;

// Leave an incomplete UTF-8 character for the next poll, including when the log is still being written.
const completeUtf8Length = (bytes: Uint8Array): number => {
	let lead = bytes.length - 1;
	while (lead >= 0 && (bytes[lead] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX) lead -= 1;
	if (lead < 0) return bytes.length;
	const first = bytes[lead];
	const expected = first >= UTF8_FOUR_BYTE_MIN && first <= UTF8_FOUR_BYTE_MAX ? UTF8_FOUR_BYTES : first >= UTF8_THREE_BYTE_MIN && first <= UTF8_THREE_BYTE_MAX ? UTF8_THREE_BYTES : first >= UTF8_TWO_BYTE_MIN && first <= UTF8_TWO_BYTE_MAX ? UTF8_TWO_BYTES : 1;
	return bytes.length - lead < expected ? lead : bytes.length;
};

const load = async (r: RuntimePorts, id: string): Promise<ApiResult<RecordData>> => {
	const m = messagesFor(r.language).exec;
	if (!ID_PATTERN.test(id)) return apiFail(EXEC_BAD_ID, m.badId());
	try {
		const value: unknown = JSON.parse(await r.fs.readText(file(r, id, "record.json")));
		return validRecord(value, id) ? apiOk(value) : apiFail(EXEC_INVALID, m.invalid());
	} catch (error) { return missing(error) ? apiFail(EXEC_UNKNOWN, m.unknown()) : error instanceof SyntaxError ? apiFail(EXEC_INVALID, m.invalid()) : io(r, error); }
};

// The runner's identity is missing until the runner has written it; undefined means missing, any other read failure is an I/O error.
const readIdentity = async (r: RuntimePorts, id: string): Promise<ApiResult<unknown>> => {
	try { return apiOk(JSON.parse(await r.fs.readText(file(r, id, "identity.json")))); }
	catch (error) { return missing(error) ? apiOk(undefined) : io(r, error); }
};

// The runner is alive only while a process with its pid and creation time exists. `absent` means no process holds the pid at all.
type RunnerState = { alive: true } | { alive: false; pid: number | null; absent: boolean };
const processAbsent = (found: string | null | undefined): boolean => found === undefined || found === null;
const runnerState = async (r: RuntimePorts, id: string): Promise<ApiResult<RunnerState>> => {
	const identity = await readIdentity(r, id);
	if (!identity.ok) return identity;
	if (!validIdentity(identity.value)) return apiOk({ alive: false, pid: null, absent: true });
	const { pid, pidCreated } = identity.value;
	const created = await r.process.createdAt([pid]);
	if (!created.ok) return io(r, created.error);
	const found = created.value[pid];
	return found === pidCreated ? apiOk({ alive: true }) : apiOk({ alive: false, pid, absent: processAbsent(found) });
};

// The one place a lost end is written: exclusive, so the first end wins, as for every other end.
const recordLost = async (r: RuntimePorts, id: string, reason: string): Promise<ApiResult<boolean>> => {
	const written = await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "lost", code: null, at: r.clock.nowText(), reason }));
	return written.ok ? apiOk(written.value) : io(r, written.error);
};

// A dead runner on POSIX leaves its shell and their children running in the runner's process group. A group id of a live group
// cannot be reused as a pid, so while no process holds the runner's pid the group is still the old one and killing it is safe;
// a different process holding the pid means the old group is gone. On Windows the runner's kill-on-close job already ended the
// children when the runner died. The group may be empty already (the shell ended normally), so a failed kill is not an error.
const reapGroup = async (r: RuntimePorts, state: RunnerState): Promise<void> => {
	if (state.alive || r.platform === "windows" || state.pid === null || !state.absent) return;
	await r.process.killGroup(state.pid);
};

const summary = async (r: RuntimePorts, record: RecordData): Promise<ApiResult<Summary>> => {
	const base = record.shell === "rig" ? { id: record.id, shell: record.shell, args: record.args, startedAt: record.startedAt } : { id: record.id, shell: record.shell, cwd: record.cwd, startedAt: record.startedAt };
	const lost = (reason: string): ApiResult<Summary> => apiOk({ ...base, state: "ended", end: { kind: "lost", code: null, at: r.clock.nowText(), reason } });
	try {
		const exitPath = file(r, record.id, "exit.json");
		if (await r.fs.stat(exitPath) !== null) {
			try {
				const value: unknown = JSON.parse(await r.fs.readText(exitPath));
				return validEnd(value) ? apiOk({ ...base, state: "ended", end: value }) : lost("invalid-end");
			} catch { return lost("unreadable-end"); }
		}
		// An unreadable or invalid heartbeat counts as stale: only the runner's identity decides whether the run is lost.
		let timestamp = Number.NEGATIVE_INFINITY;
		try { timestamp = Date.parse(await r.fs.readText(file(r, record.id, "heartbeat"))); } catch { /* counts as stale */ }
		if (Number.isFinite(timestamp) && r.clock.now().getTime() - timestamp < EXEC_STALE_MS) return apiOk({ ...base, state: "running" });
		// A stale heartbeat alone is never an end (machine sleep, a long stall): the run is lost only when the runner is gone, and that is recorded once.
		const runner = await runnerState(r, record.id);
		if (!runner.ok) return runner;
		if (runner.value.alive) return apiOk({ ...base, state: "running" });
		const recorded = await recordLost(r, record.id, "process-gone");
		if (!recorded.ok) return recorded;
		return summary(r, record);
	} catch { return lost("unreadable-end"); }
};

const scan = async (r: RuntimePorts): Promise<ApiResult<{ runs: Summary[]; broken: string[] }>> => {
	try {
		const entries = await r.fs.listDirectory(root(r)).catch((error: unknown) => { if (missing(error)) return []; throw error; });
		const runs: Summary[] = [];
		const broken: string[] = [];
		for (const entry of entries) {
			if (!entry.directory || !ID_PATTERN.test(entry.name)) continue;
			const record = await load(r, entry.name);
			if (!record.ok) { broken.push(entry.name); continue; }
			const state = await summary(r, record.value);
			if (!state.ok) return state;
			runs.push(state.value);
		}
		runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
		return apiOk({ runs, broken });
	} catch (error) { return io(r, error); }
};

type StartTarget = { kind: "shell"; shell: ExecShell; cwd: string; text: string } | { kind: "rig"; args: readonly string[] };

const start = async (r: RuntimePorts, target: StartTarget): Promise<ApiResult<JsonValue>> => {
	const m = messagesFor(r.language).exec;
	const state = await readState(r.fs, r.home, messagesFor(r.language));
	if (!state.ok) return apiFail(EXEC_IO, m.io(state.error));
	let resolved = "";
	if (target.kind === "rig") {
		if (target.args.length === 0 || EXEC_RIG_REFUSED.has(target.args[0])) return apiFail(ERROR_CODE_USAGE, m.usage());
	} else {
		if (target.shell !== "bash" && (r.platform !== "windows" || state.value.features[target.shell] !== true)) return apiFail(EXEC_UNAVAILABLE, m.unavailable());
		if (target.cwd.length === 0) return apiFail(EXEC_INVALID, m.invalid());
		resolved = r.resolvePath(target.cwd);
		try { await r.fs.listDirectory(resolved); } catch (error) { return io(r, error); }
	}
	const listed = await scan(r);
	if (!listed.ok) return listed;
	try {
		for (const id of listed.value.broken) {
			// A start creates the directory and writes its record within moments, so a younger record-less directory may be a start in progress; the stale window is the age that rules that out.
			const modified = await r.fs.modifiedAt(dir(r, id));
			if (modified === null || r.clock.now().getTime() - modified < EXEC_STALE_MS) continue;
			try { await r.fs.removeDirectoryTree(dir(r, id)); } catch (error) { if (!missing(error)) throw error; }
		}
		let excess = Math.max(0, listed.value.runs.length - (EXEC_MAX_RUNS - 1));
		for (const run of [...listed.value.runs].reverse()) {
			if (excess === 0) break;
			if (run.state === "ended") { try { await r.fs.removeDirectoryTree(dir(r, run.id)); } catch (error) { if (!missing(error)) throw error; } excess -= 1; }
		}
		const id = r.ids.next();
		if (!ID_PATTERN.test(id)) return apiFail(EXEC_BAD_ID, m.badId());
		const path = dir(r, id);
		await r.fs.ensureDirectory(path);
		const startedAt = r.clock.nowText();
		const record: RecordData = target.kind === "rig" ? { id, shell: "rig", args: [...target.args], startedAt } : { id, shell: target.shell, cwd: resolved, text: target.text, startedAt };
		await r.fs.writeText(file(r, id, "heartbeat"), record.startedAt);
		await r.fs.writeText(file(r, id, "log"), "");
		const created = await r.fs.writeExclusive(file(r, id, "record.json"), JSON.stringify(record));
		if (!created.ok) return apiFail(EXEC_IO, m.io(created.error));
		if (!created.value) return apiFail(EXEC_INVALID, m.invalid());
		const spawned = await r.process.spawnDetached([r.executablePath, r.resolvePath(state.value.paths.repo, "src", "cli.ts"), "exec-runner", id], 0, EXEC_RUNNER_STDERR_LIMIT, file(r, id, "runner-stderr"), { windowsHide: true });
		if (!spawned.ok || spawned.value.pid === undefined) { const reason = spawned.ok ? messagesFor(r.language).failure.missingProcessId() : spawned.error; await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "lost", code: null, at: r.clock.nowText(), reason: "start-failed" })); return apiFail(EXEC_LAUNCH, m.launch(reason)); }
		const pid = spawned.value.pid;
		const started: JsonValue = record.shell === "rig" ? { id, shell: "rig", pid, startedAt: record.startedAt } : { id, shell: record.shell, cwd: resolved, pid, startedAt: record.startedAt };
		return apiOk(started);
	} catch (error) { return io(r, error); }
};

// The status object at this moment, and whether a waiting call may answer with it: the run has ended, or the log holds
// bytes past `from` (a partial UTF-8 character alone is not an answer; the wait goes on until it completes).
type Snapshot = { value: JsonValue; ready: boolean };
const snapshot = async (r: RuntimePorts, id: string, record: RecordData, from: number): Promise<ApiResult<Snapshot>> => {
	const state = await summary(r, record);
	if (!state.ok) return state;
	try {
		const path = file(r, id, "log");
		const info = await r.fs.stat(path);
		const size = info?.size ?? 0;
		const start = Math.min(from, size);
		const bytes = info === null ? new Uint8Array() : await r.fs.readRange(path, start, Math.min(EXEC_LOG_CHUNK_BYTES, size - start));
		const length = state.value.state === "running" || start + bytes.length < size ? completeUtf8Length(bytes) : bytes.length;
		const log = { from: start, to: start + length, size, text: new TextDecoder().decode(bytes.subarray(0, length)) };
		const ready = state.value.state === "ended" || start + length > from;
		if (record.shell !== "rig" || state.value.state !== "ended" || state.value.end === undefined) return apiOk({ value: { ...state.value, log }, ready });
		const outcome = await rigResult(r, id);
		if (outcome.result !== undefined) return apiOk({ value: { ...state.value, result: outcome.result, log }, ready });
		const end = state.value.end.kind === "exit" && state.value.end.reason === undefined ? { ...state.value.end, reason: outcome.reason } : state.value.end;
		return apiOk({ value: { ...state.value, end, log }, ready });
	} catch (error) { return io(r, error); }
};

// Without a wait (`waitMs` 0) this is the plain status. With a wait it answers as soon as the snapshot is ready, or once
// `waitMs` has passed, whichever comes first; the sleep is cut to the time left, and both times come from the injected clock.
const status = async (r: RuntimePorts, id: string, from: number, waitMs = 0): Promise<ApiResult<JsonValue>> => {
	if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0) return apiFail(EXEC_INVALID, messagesFor(r.language).exec.invalid());
	const record = await load(r, id);
	if (!record.ok) return record;
	const deadline = r.clock.now().getTime() + waitMs;
	for (;;) {
		const answer = await snapshot(r, id, record.value, from);
		if (!answer.ok) return answer;
		const remaining = deadline - r.clock.now().getTime();
		if (answer.value.ready || remaining <= 0) return apiOk(answer.value.value);
		await r.clock.sleep(Math.min(EXEC_WAIT_POLL_MS, remaining));
	}
};

// The stdout of a rig run is its one JSON object; anything else is no result, with the reason.
const rigResult = async (r: RuntimePorts, id: string): Promise<{ result?: JsonValue; reason: string }> => {
	let text = "";
	try { text = await r.fs.readText(file(r, id, "result")); } catch (error) { if (!missing(error)) throw error; }
	if (text.trim().length === 0) return { reason: "empty-result" };
	try {
		const value: JsonValue = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? { result: value, reason: "" } : { reason: "invalid-result" };
	} catch { return { reason: "invalid-result" }; }
};

// The time of the stop request, null when there is none or it cannot be read or parsed.
const readRequestAt = async (r: RuntimePorts, id: string): Promise<number | null> => {
	try {
		const at = Date.parse(await r.fs.readText(file(r, id, "stop-request")));
		return Number.isFinite(at) ? at : null;
	} catch { return null; }
};

// Records the stop request unless a readable one exists: a repeated stop never moves the time, so the grace counts from the first request.
const requestStop = async (r: RuntimePorts, id: string): Promise<ApiResult<number>> => {
	const existing = await readRequestAt(r, id);
	if (existing !== null) return apiOk(existing);
	const text = r.clock.nowText();
	try { await r.fs.writeText(file(r, id, "stop-request"), text); } catch (error) { return io(r, error); }
	return apiOk(Date.parse(text));
};

// A stop is a request: the runner alone decides the end (see `superviseRun`) and kills its run's processes itself. Only a
// runner that is gone, or one that has not acted within EXEC_STOP_GRACE_MS (a hung runner), is killed from outside.
const stop = async (r: RuntimePorts, id: string): Promise<ApiResult<JsonValue>> => {
	const record = await load(r, id);
	if (!record.ok) return record;
	const current = await summary(r, record.value);
	if (!current.ok) return current;
	if (current.value.state === "ended") {
		if (current.value.end?.kind === "lost") {
			const runner = await runnerState(r, id);
			if (!runner.ok) return runner;
			await reapGroup(r, runner.value);
		}
		return apiOk({ id, state: "ended" });
	}
	const identity = await readIdentity(r, id);
	if (!identity.ok) return identity;
	if (identity.value === undefined) {
		// The runner has not written its identity yet: record the stop, which the runner checks after writing it and before launching the shell.
		const early = await requestStop(r, id);
		return early.ok ? apiOk({ id, stopping: true }) : early;
	}
	const parsed = identity.value;
	if (!validIdentity(parsed)) return apiFail(EXEC_LAUNCH, messagesFor(r.language).exec.launch(messagesFor(r.language).failure.processIdentityUnavailable()));
	const { pid, pidCreated } = parsed;
	const created = await r.process.createdAt([pid]);
	if (!created.ok) return apiFail(EXEC_IO, messagesFor(r.language).exec.io(created.error));
	if (created.value[pid] !== pidCreated) {
		const written = await recordLost(r, id, "process-gone");
		if (!written.ok) return written;
		await reapGroup(r, { alive: false, pid, absent: processAbsent(created.value[pid]) });
		return apiOk({ id, state: "ended" });
	}
	const latest = await summary(r, record.value);
	if (!latest.ok) return latest;
	if (latest.value.state === "ended") return apiOk({ id, state: "ended" });
	const requestedAt = await requestStop(r, id);
	if (!requestedAt.ok) return requestedAt;
	if (r.clock.now().getTime() - requestedAt.value < EXEC_STOP_GRACE_MS) return apiOk({ id, stopping: true });
	// The runner did not act within the grace: kill the run from outside. The run is one unit: a kill-on-close job on Windows, the runner's own process group on POSIX.
	const killed = r.platform === "windows" ? await r.process.killTree(pid, true) : await r.process.killGroup(pid);
	if (!killed.ok) return apiFail(EXEC_IO, messagesFor(r.language).exec.io(killed.error));
	const written = await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "stopped", code: null, at: r.clock.nowText() }));
	if (!written.ok) return apiFail(EXEC_IO, messagesFor(r.language).exec.io(written.error));
	return written.value ? apiOk({ id, stopping: true }) : apiOk({ id, state: "ended" });
};

export const startExec = (r: RuntimePorts, shell: ExecShell, cwd: string, text: string): Promise<ApiResult<JsonValue>> => start(r, { kind: "shell", shell, cwd, text });
export const startRigExec = (r: RuntimePorts, args: readonly string[]): Promise<ApiResult<JsonValue>> => start(r, { kind: "rig", args });
export const stopExec = stop;
export const statusExec = status;
export const listExecs = async (r: RuntimePorts): Promise<ApiResult<{ runs: Summary[] }>> => {
	const listed = await scan(r);
	return listed.ok ? apiOk({ runs: listed.value.runs }) : listed;
};

// Rig's own CLI runs with the runner's environment minus the secret-bearing variables: its commands read none of them.
const rigLaunch = async (r: RuntimePorts, args: readonly string[]): Promise<ApiResult<ShellLaunch>> => {
	const state = await readState(r.fs, r.home, messagesFor(r.language));
	if (!state.ok) return apiFail(EXEC_IO, messagesFor(r.language).exec.io(state.error));
	return apiOk({ argv: [r.executablePath, r.resolvePath(state.value.paths.repo, "src", "cli.ts"), ...args], env: cleanEnvironment(r.environment.entries()), files: [] });
};

const joinChunks = (chunks: Uint8Array[]): Uint8Array => {
	const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
};

// What the runner learns about the command it started: null while it runs, then its result (an error is a failed launch).
type CommandState = { result: Result<StreamingRun> | null };
type Supervised = { end: End; command: StreamingRun | null };

// The runner alone decides how a run ends, from facts it observes in a fixed order each poll: the stop request, then
// whether the command has exited, then (only once it has) how many processes of the run are left. A command that is
// still running is itself a member, so it needs no count. The decision:
// - the command has exited and no member is left: the run is empty; the end is `stopped` if this runner killed members
//   because of a request, else `exit` with the command's code (a request that arrives later changes nothing: nothing
//   was killed, and the real end is kept);
// - a request and a member left: this runner kills its run's members (retried every poll until none is left);
// - a check that cannot be read (the request, or the count once the command has exited) is never an answer: it is
//   retried on the next poll, and when it keeps failing for the stale window the runner kills what is left and ends
//   with the command's code and the reason EXEC_CHECK_FAILED_REASON.
const superviseRun = async (r: RuntimePorts, id: string, command: CommandState, settled: Promise<void>): Promise<Supervised> => {
	let killedForRequest = false;
	let failingSince: number | null = null;
	for (;;) {
		let requested: boolean | null = null;
		try { requested = await r.fs.stat(file(r, id, "stop-request")) !== null; } catch { requested = null; }
		const result = command.result;
		if (result !== null && !result.ok) return { end: { kind: "exit", code: null, at: r.clock.nowText(), reason: result.error }, command: null };
		const exited = result !== null && result.ok ? result.value : null;
		let members: number | null = 1;
		if (exited !== null) {
			const counted = await r.process.runMembers();
			members = counted.ok ? counted.value : null;
		}
		if (members === 0 && exited !== null && requested !== null) {
			return { end: killedForRequest ? { kind: "stopped", code: null, at: r.clock.nowText() } : { kind: "exit", code: exited.code, at: r.clock.nowText() }, command: exited };
		}
		// A command that is still running is a member, so only a check made after its exit can fail the run.
		if (exited !== null && (requested === null || members === null)) {
			const now = r.clock.now().getTime();
			failingSince ??= now;
			// A known request is honoured even while the count fails: the members are killed whether or not they can be counted.
			if (requested === true && (await r.process.killRunMembers()).ok) killedForRequest = true;
			if (now - failingSince >= EXEC_STALE_MS) {
				await r.process.killRunMembers();
				return { end: { kind: "exit", code: exited.code, at: r.clock.nowText(), reason: EXEC_CHECK_FAILED_REASON }, command: exited };
			}
		} else {
			failingSince = null;
			if (requested === true && (members === null || members > 0)) {
				const killed = await r.process.killRunMembers();
				if (killed.ok) killedForRequest = true;
			}
		}
		// A command that exits meanwhile ends the wait at once, so a quick command does not wait out a whole poll. The sleep
		// is cancelled when the command wins, so no timer is left pending to hold the runner process open.
		const wake = new AbortController();
		const slept = r.clock.sleep(EXEC_RUN_POLL_MS, wake.signal);
		await (command.result === null ? Promise.race([settled, slept]) : slept);
		wake.abort();
	}
};

export const runExecRunner = async (r: RuntimePorts, id: string, build: ShellBuilder): Promise<number> => {
	const record = await load(r, id);
	if (!record.ok) return 1;
	const path = dir(r, id);
	// Records the end and reports true when that end (or the stop recorded instead) is written. When it cannot be written, a last-resort end names the failure and this reports false; it never throws.
	const finish = async (end: End): Promise<boolean> => {
		try {
			const written = await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify(end));
			if (written.ok) return true;
		} catch { /* The last-resort end below records the failure. */ }
		try {
			await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "exit", code: EXEC_RUNNER_FAILED_CODE, at: r.clock.nowText(), reason: EXEC_END_WRITE_FAILED }));
		} catch { /* No end can be written: the stale heartbeat ends the run as lost. */ }
		return false;
	};
	try {
		const pid = r.lock.process.pid;
		const created = await r.process.createdAt([pid]);
		const pidCreated = created.ok ? created.value[pid] : null;
		if (!pidCreated) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: created.ok ? messagesFor(r.language).failure.processIdentityUnavailable() : created.error }); return 1; }
		const identity = await atomicWrite(r.fs, file(r, id, "identity.json"), JSON.stringify({ pid, pidCreated }), messagesFor(r.language));
		if (!identity.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: identity.error }); return 1; }
		// A stop recorded before the identity existed is honoured here: the run ends stopped and no shell is launched.
		if (await r.fs.stat(file(r, id, "stop-request")) !== null) { return (await finish({ kind: "stopped", code: null, at: r.clock.nowText() })) ? 0 : 1; }
		const rig = record.value.shell === "rig" ? record.value : null;
		const launch = rig !== null ? await rigLaunch(r, rig.args) : record.value.shell === "rig" ? apiFail(EXEC_INVALID, messagesFor(r.language).exec.invalid()) : await build(r, record.value.shell, record.value.text, path);
		if (!launch.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: launch.error.message }); return 1; }
		for (const item of launch.value.files) await r.fs.writeBytes(item.path, item.bytes);
		const beat = (): void => { void atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText(), messagesFor(r.language)); };
		const initialBeat = await atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText(), messagesFor(r.language));
		if (!initialBeat.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: initialBeat.error }); return 1; }
		const cancel = r.clock.every(EXEC_HEARTBEAT_MS, beat);
		try {
			// The result is one JSON object: its stdout is collected and written whole once the run has ended.
			const stdout: Uint8Array[] = [];
			const command: CommandState = { result: null };
			const settled = r.process.runStreaming(launch.value.argv, record.value.shell === "rig" ? rigHome(r) : record.value.cwd, launch.value.env, (bytes) => r.fs.appendBytes(file(r, id, "log"), bytes), launch.value.verbatimArguments ?? false, rig === null ? undefined : async (bytes) => { stdout.push(bytes.slice()); })
				.then((value) => { command.result = value; }, (error: unknown) => { command.result = err(errorText(error)); });
			// The run is one unit: it stays running while any process of it lives, and ends with the command's own code
			// once the last one is gone. Output keeps arriving meanwhile.
			const supervised = await superviseRun(r, id, command, settled);
			if (supervised.command === null) { await finish(supervised.end); return 1; }
			const drained = await supervised.command.finishOutput();
			if (rig !== null) await r.fs.writeBytes(file(r, id, "result"), joinChunks(stdout));
			const end: End = drained.ok || supervised.end.kind === "stopped" || supervised.end.reason !== undefined ? supervised.end : { kind: "exit", code: null, at: r.clock.nowText(), reason: drained.error };
			const ended = await finish(end);
			return drained.ok && ended ? 0 : 1;
		} finally { cancel(); }
	} catch (error) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: errorText(error) }); return 1; }
};
