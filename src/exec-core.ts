import type { ApiResult, JsonValue } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { ID_PATTERN } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import { cleanEnvironment } from "./clean-environment.js";
import { atomicWrite, joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, EXEC_BAD_ID, EXEC_INVALID, EXEC_IO, EXEC_LAUNCH, EXEC_UNAVAILABLE, EXEC_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";
import { readState } from "./state.js";

// Hub exec-runner.ts HEARTBEAT_MS and exec.ts HEARTBEAT_STALE_MS / MAX_EXECS.
export const EXEC_HEARTBEAT_MS = 10_000;
export const EXEC_STALE_MS = 3 * EXEC_HEARTBEAT_MS;
export const EXEC_MAX_RUNS = 50;
// The hub reads at most 64 KiB for a log tail; use the same bound per API response.
export const EXEC_LOG_CHUNK_BYTES = 64 * 1024;
// Keep startup diagnostics bounded to the same 64 KiB diagnostic budget independently of log paging.
const EXEC_RUNNER_STDERR_LIMIT = 64 * 1024;
// How often the runner checks whether a run still holds a process after its command has exited. The wait for the last
// process is not busy: this bounds the delay of the recorded end (at most this long after the last process is gone)
// against the cost of a check (one `ps` start per check on POSIX); one second is far below the heartbeat interval.
export const EXEC_RUN_POLL_MS = 1_000;
// Written by the runner (atomically) with the time at which the run held no process but the runner; `stop` reads it.
const EXEC_RUN_EMPTY_FILE = "run-empty";
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
	const state = await readState(r.fs, r.home);
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
		if (!spawned.ok || spawned.value.pid === undefined) { const reason = spawned.ok ? "Missing process ID" : spawned.error; await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "lost", code: null, at: r.clock.nowText(), reason: "start-failed" })); return apiFail(EXEC_LAUNCH, m.launch(reason)); }
		const pid = spawned.value.pid;
		const started: JsonValue = record.shell === "rig" ? { id, shell: "rig", pid, startedAt: record.startedAt } : { id, shell: record.shell, cwd: resolved, pid, startedAt: record.startedAt };
		return apiOk(started);
	} catch (error) { return io(r, error); }
};

const status = async (r: RuntimePorts, id: string, from: number): Promise<ApiResult<JsonValue>> => {
	if (!Number.isSafeInteger(from) || from < 0) return apiFail(EXEC_INVALID, messagesFor(r.language).exec.invalid());
	const record = await load(r, id);
	if (!record.ok) return record;
	const state = await summary(r, record.value);
	if (!state.ok) return state;
	try {
		const path = file(r, id, "log");
		const info = await r.fs.stat(path);
		const size = info?.size ?? 0;
		const start = Math.min(from, size);
		const bytes = info === null ? new Uint8Array() : await r.fs.readRange(path, start, Math.min(EXEC_LOG_CHUNK_BYTES, size - start));
		const length = state.value.state === "running" || start + bytes.length < size ? completeUtf8Length(bytes) : bytes.length;
			const log = { from: start, to: start + length, size, text: new TextDecoder().decode(bytes.subarray(0, length)) };
		if (record.value.shell !== "rig" || state.value.state !== "ended" || state.value.end === undefined) return apiOk({ ...state.value, log });
		const outcome = await rigResult(r, id);
		if (outcome.result !== undefined) return apiOk({ ...state.value, result: outcome.result, log });
		const end = state.value.end.kind === "exit" && state.value.end.reason === undefined ? { ...state.value.end, reason: outcome.reason } : state.value.end;
		return apiOk({ ...state.value, end, log });
	} catch (error) { return io(r, error); }
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
	const marker = file(r, id, "stop-request");
	let identity = await readIdentity(r, id);
	if (!identity.ok) return identity;
	if (identity.value === undefined) {
		// The runner has not written its identity yet: record the stop, which the runner checks after writing it and before launching the shell.
		try { await r.fs.writeText(marker, r.clock.nowText()); } catch (error) { return io(r, error); }
		// The runner may have written its identity after the first read and checked before the request existed: then kill as usual.
		identity = await readIdentity(r, id);
		if (!identity.ok) return identity;
		if (identity.value === undefined) return apiOk({ id, stopping: true });
	}
	const parsed = identity.value;
	if (!validIdentity(parsed)) return apiFail(EXEC_LAUNCH, messagesFor(r.language).exec.launch("Process identity unavailable"));
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
	const requestAt = r.clock.nowText();
	try { await r.fs.writeText(marker, requestAt); } catch (error) { return io(r, error); }
	// Every process of the run had already ended before this request: the run ends by itself with its real end, which the runner is recording now; nothing is killed.
	if (stopCameAfterEmpty(requestAt, await readRunEmpty(r, id))) return apiOk({ id, stopping: true });
	// The run is one unit: a kill-on-close job on Windows, the runner's own process group on POSIX.
	const killed = r.platform === "windows" ? await r.process.killTree(pid, true) : await r.process.killGroup(pid);
	if (!killed.ok) {
		try { await r.fs.remove(marker); } catch (error) { return io(r, error); }
		return apiFail(EXEC_IO, messagesFor(r.language).exec.io(killed.error));
	}
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
	const state = await readState(r.fs, r.home);
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

// A stop request ends a run as stopped unless every process of the run had already ended before the request was
// written: then the run ended on its own and keeps its real end. Both times come from the injected clock. A tie, a
// missing run-empty time and a time that does not parse all count as a stop (the safe side: the request was honoured).
export const stopCameAfterEmpty = (requestAt: string, emptyAt: string | null): boolean => {
	if (emptyAt === null) return false;
	const request = Date.parse(requestAt);
	const empty = Date.parse(emptyAt);
	return Number.isFinite(request) && Number.isFinite(empty) && empty < request;
};

// The time at which the run was observed empty, or null while no such time is recorded (or it cannot be read).
const readRunEmpty = async (r: RuntimePorts, id: string): Promise<string | null> => {
	try {
		const text = await r.fs.readText(file(r, id, EXEC_RUN_EMPTY_FILE));
		return text.length === 0 ? null : text;
	} catch { return null; }
};

// Waits until the run holds no process but the runner, and returns the time that was observed (also written to the
// run-empty file for `stop`). A run that cannot be counted counts as empty: the command already exited, so waiting on a
// count that cannot be read would hold the run forever.
const awaitRunEmpty = async (r: RuntimePorts, id: string): Promise<string> => {
	for (;;) {
		const members = await r.process.runMembers();
		if (!members.ok || members.value === 0) break;
		await r.clock.sleep(EXEC_RUN_POLL_MS);
	}
	const emptyAt = r.clock.nowText();
	await atomicWrite(r.fs, file(r, id, EXEC_RUN_EMPTY_FILE), emptyAt);
	return emptyAt;
};

export const runExecRunner = async (r: RuntimePorts, id: string, build: ShellBuilder): Promise<number> => {
	const record = await load(r, id);
	if (!record.ok) return 1;
	const path = dir(r, id);
	// Records the end and reports true when that end (or the stop recorded instead) is written. When it cannot be written, a last-resort end names the failure and this reports false; it never throws.
	// emptyAt is the time the run was observed empty (null when the command never ran): a stop request written after it does not turn the end into a stop.
	const finish = async (end: End, emptyAt: string | null = null): Promise<boolean> => {
		try {
			const request = await r.fs.stat(file(r, id, "stop-request")) !== null ? await r.fs.readText(file(r, id, "stop-request")) : null;
			const stopped = request !== null && !stopCameAfterEmpty(request, emptyAt);
			const written = await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify(stopped ? { kind: "stopped", code: null, at: r.clock.nowText() } : end));
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
		if (!pidCreated) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: created.ok ? "Process identity unavailable" : created.error }); return 1; }
		const identity = await atomicWrite(r.fs, file(r, id, "identity.json"), JSON.stringify({ pid, pidCreated }));
		if (!identity.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: identity.error }); return 1; }
		// A stop recorded before the identity existed is honoured here: the run ends stopped and no shell is launched.
		if (await r.fs.stat(file(r, id, "stop-request")) !== null) { return (await finish({ kind: "stopped", code: null, at: r.clock.nowText() })) ? 0 : 1; }
			const rig = record.value.shell === "rig" ? record.value : null;
		const launch = rig !== null ? await rigLaunch(r, rig.args) : record.value.shell === "rig" ? apiFail(EXEC_INVALID, "Invalid exec record") : await build(r, record.value.shell, record.value.text, path);
		if (!launch.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: launch.error.message }); return 1; }
		for (const item of launch.value.files) await r.fs.writeBytes(item.path, item.bytes);
		const beat = (): void => { void atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText()); };
		const initialBeat = await atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText());
		if (!initialBeat.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: initialBeat.error }); return 1; }
		const cancel = r.clock.every(EXEC_HEARTBEAT_MS, beat);
		try {
			// The result is one JSON object: its stdout is collected and written whole once the run has ended.
			const stdout: Uint8Array[] = [];
			const started = await r.process.runStreaming(launch.value.argv, record.value.shell === "rig" ? rigHome(r) : record.value.cwd, launch.value.env, (bytes) => r.fs.appendBytes(file(r, id, "log"), bytes), launch.value.verbatimArguments ?? false, rig === null ? undefined : async (bytes) => { stdout.push(bytes.slice()); });
			if (!started.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: started.error }); return 1; }
			// The run is one unit: it stays running while any process of it lives, and ends with the command's own code
			// (remembered here, at the command's exit) once the last one is gone. Output keeps arriving meanwhile.
			const code = started.value.code;
			const emptyAt = await awaitRunEmpty(r, id);
			const drained = await started.value.finishOutput();
			if (rig !== null) await r.fs.writeBytes(file(r, id, "result"), joinChunks(stdout));
			const ended = await finish(drained.ok ? { kind: "exit", code, at: r.clock.nowText() } : { kind: "exit", code: null, at: r.clock.nowText(), reason: drained.error }, emptyAt);
			return drained.ok && ended ? 0 : 1;
		} finally { cancel(); }
	} catch (error) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: errorText(error) }); return 1; }
};
