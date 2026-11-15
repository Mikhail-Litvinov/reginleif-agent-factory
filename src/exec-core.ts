import type { ApiResult, JsonValue } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { ID_PATTERN } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import { atomicWrite, joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, EXEC_BAD_ID, EXEC_INVALID, EXEC_IO, EXEC_LAUNCH, EXEC_UNAVAILABLE, EXEC_UNKNOWN } from "./output.js";
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
type RecordData = { id: string; shell: ExecShell; cwd: string; text: string; startedAt: string };
type Identity = { pid: number; pidCreated: string };
type End = { kind: "exit" | "stopped" | "lost"; code: number | null; at: string; reason?: string };
type Summary = { id: string; shell: ExecShell; cwd: string; state: "running" | "ended"; startedAt: string; end?: End };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shellValue = (value: unknown): value is ExecShell => value === "pwsh" || value === "cmd" || value === "bash";
const root = (r: RuntimePorts): string => joinPath(r.home, ".agent-rig", "exec");
const dir = (r: RuntimePorts, id: string): string => joinPath(root(r), id);
const file = (r: RuntimePorts, id: string, name: string): string => joinPath(dir(r, id), name);
const missing = (error: unknown): boolean => object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
const io = (r: RuntimePorts, error: unknown): ApiResult<never> => apiFail(EXEC_IO, messagesFor(r.language).exec.io(errorText(error)));
const validRecord = (value: unknown, id: string): value is RecordData => object(value) && value.id === id && shellValue(value.shell) && typeof value.cwd === "string" && typeof value.text === "string" && typeof value.startedAt === "string";
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

const summary = async (r: RuntimePorts, record: RecordData): Promise<ApiResult<Summary>> => {
	const base = { id: record.id, shell: record.shell, cwd: record.cwd, startedAt: record.startedAt };
	const lost = (reason: string): ApiResult<Summary> => apiOk({ ...base, state: "ended", end: { kind: "lost", code: null, at: r.clock.nowText(), reason } });
	try {
		const exitPath = file(r, record.id, "exit.json");
		if (await r.fs.stat(exitPath) !== null) {
			try {
				const value: unknown = JSON.parse(await r.fs.readText(exitPath));
				return validEnd(value) ? apiOk({ ...base, state: "ended", end: value }) : lost("invalid-end");
			} catch { return lost("unreadable-end"); }
		}
		let heartbeat: string;
		try { heartbeat = await r.fs.readText(file(r, record.id, "heartbeat")); } catch { return lost("unreadable-heartbeat"); }
		const timestamp = Date.parse(heartbeat);
		if (!Number.isFinite(timestamp)) return lost("invalid-heartbeat");
		if (r.clock.now().getTime() - timestamp >= EXEC_STALE_MS) return apiOk({ ...base, state: "ended", end: { kind: "lost", code: null, at: r.clock.nowText(), reason: "process-gone" } });
		return apiOk({ ...base, state: "running" });
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

const start = async (r: RuntimePorts, shell: ExecShell, cwd: string, text: string): Promise<ApiResult<JsonValue>> => {
	const m = messagesFor(r.language).exec;
	const state = await readState(r.fs, r.home);
	if (!state.ok) return apiFail(EXEC_IO, m.io(state.error));
	if (shell !== "bash" && (r.platform !== "windows" || state.value.features[shell] !== true)) return apiFail(EXEC_UNAVAILABLE, m.unavailable());
	if (cwd.length === 0) return apiFail(EXEC_INVALID, m.invalid());
	const resolved = r.resolvePath(cwd);
	try { await r.fs.listDirectory(resolved); } catch (error) { return io(r, error); }
	const listed = await scan(r);
	if (!listed.ok) return listed;
	try {
		for (const id of listed.value.broken) {
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
		const record: RecordData = { id, shell, cwd: resolved, text, startedAt: r.clock.nowText() };
		await r.fs.writeText(file(r, id, "heartbeat"), record.startedAt);
		await r.fs.writeText(file(r, id, "log"), "");
		const created = await r.fs.writeExclusive(file(r, id, "record.json"), JSON.stringify(record));
		if (!created.ok) return apiFail(EXEC_IO, m.io(created.error));
		if (!created.value) return apiFail(EXEC_INVALID, m.invalid());
		const spawned = await r.process.spawnDetached([r.executablePath, r.resolvePath(state.value.paths.repo, "src", "cli.ts"), "exec-runner", id], 0, EXEC_RUNNER_STDERR_LIMIT, file(r, id, "runner-stderr"), { windowsHide: true });
		if (!spawned.ok || spawned.value.pid === undefined) { const reason = spawned.ok ? "Missing process ID" : spawned.error; await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "lost", code: null, at: r.clock.nowText(), reason: "start-failed" })); return apiFail(EXEC_LAUNCH, m.launch(reason)); }
		const pid = spawned.value.pid;
		return apiOk({ id, shell, cwd: resolved, pid, startedAt: record.startedAt });
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
		return apiOk({ ...state.value, log: { from: start, to: start + length, size, text: new TextDecoder().decode(bytes.subarray(0, length)) } });
	} catch (error) { return io(r, error); }
};

// The identity is missing until the runner has written it; undefined means missing, any other read failure is an I/O error.
const readIdentity = async (r: RuntimePorts, id: string): Promise<ApiResult<unknown>> => {
	try { return apiOk(JSON.parse(await r.fs.readText(file(r, id, "identity.json")))); }
	catch (error) { return missing(error) ? apiOk(undefined) : io(r, error); }
};

const stop = async (r: RuntimePorts, id: string): Promise<ApiResult<JsonValue>> => {
	const record = await load(r, id);
	if (!record.ok) return record;
	const current = await summary(r, record.value);
	if (!current.ok) return current;
	if (current.value.state === "ended") return apiOk({ id, state: "ended" });
	const marker = file(r, id, "stop-request");
	let identity = await readIdentity(r, id);
	if (!identity.ok) return identity;
	if (identity.value === undefined) {
		// The runner has not written its identity yet: record the stop, which the runner checks after writing it and before launching the shell.
		try { await r.fs.writeText(marker, ""); } catch (error) { return io(r, error); }
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
		const written = await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify({ kind: "lost", code: null, at: r.clock.nowText(), reason: "process-gone" }));
		return written.ok ? apiOk({ id, state: "ended" }) : apiFail(EXEC_IO, messagesFor(r.language).exec.io(written.error));
	}
	const latest = await summary(r, record.value);
	if (!latest.ok) return latest;
	if (latest.value.state === "ended") return apiOk({ id, state: "ended" });
	try { await r.fs.writeText(marker, ""); } catch (error) { return io(r, error); }
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

export const startExec = start;
export const stopExec = stop;
export const statusExec = status;
export const listExecs = async (r: RuntimePorts): Promise<ApiResult<{ runs: Summary[] }>> => {
	const listed = await scan(r);
	return listed.ok ? apiOk({ runs: listed.value.runs }) : listed;
};

export const runExecRunner = async (r: RuntimePorts, id: string, build: ShellBuilder): Promise<number> => {
	const record = await load(r, id);
	if (!record.ok) return 1;
	const path = dir(r, id);
	const finish = async (end: End): Promise<void> => {
		const stopped = await r.fs.stat(file(r, id, "stop-request")) !== null;
		await r.fs.writeExclusive(file(r, id, "exit.json"), JSON.stringify(stopped ? { kind: "stopped", code: null, at: r.clock.nowText() } : end));
	};
	try {
		const pid = r.lock.process.pid;
		const created = await r.process.createdAt([pid]);
		const pidCreated = created.ok ? created.value[pid] : null;
		if (!pidCreated) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: created.ok ? "Process identity unavailable" : created.error }); return 1; }
		const identity = await atomicWrite(r.fs, file(r, id, "identity.json"), JSON.stringify({ pid, pidCreated }));
		if (!identity.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: identity.error }); return 1; }
		// A stop recorded before the identity existed is honoured here: the run ends stopped and no shell is launched.
		if (await r.fs.stat(file(r, id, "stop-request")) !== null) { await finish({ kind: "stopped", code: null, at: r.clock.nowText() }); return 0; }
		const launch = await build(r, record.value.shell, record.value.text, path);
		if (!launch.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: launch.error.message }); return 1; }
		for (const item of launch.value.files) await r.fs.appendBytes(item.path, item.bytes);
		const beat = (): void => { void atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText()); };
		const initialBeat = await atomicWrite(r.fs, file(r, id, "heartbeat"), r.clock.nowText());
		if (!initialBeat.ok) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: initialBeat.error }); return 1; }
		const cancel = r.clock.every(EXEC_HEARTBEAT_MS, beat);
		try {
			const result = await r.process.runStreaming(launch.value.argv, record.value.cwd, launch.value.env, (bytes) => r.fs.appendBytes(file(r, id, "log"), bytes), launch.value.verbatimArguments ?? false);
			await finish(result.ok ? { kind: "exit", code: result.value, at: r.clock.nowText() } : { kind: "exit", code: null, at: r.clock.nowText(), reason: result.error });
			return result.ok ? 0 : 1;
		} finally { cancel(); }
	} catch (error) { await finish({ kind: "exit", code: null, at: r.clock.nowText(), reason: errorText(error) }); return 1; }
};
