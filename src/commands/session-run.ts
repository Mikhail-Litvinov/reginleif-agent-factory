import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { joinPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, LAUNCH_FAILED, LAUNCH_INVALID, LAUNCH_NOT_CONFIGURED, LAUNCH_TIMEOUT, SESSION_RUNNING } from "../output.js";
import { lookupSession, lookupSessionForCommand, sessionLive, SESSION_POLL_MS } from "../session-core.js";
import { accountOf, INFO_ERROR_STATE_UNREADABLE } from "./info.js";
import { readRigState } from "./shared.js";
import { stopSession } from "./session-stop.js";

// Hub launch.ts: exit grace, stderr limit and transcript block size.
const LAUNCH_EXIT_GRACE_MS = 2000;
const STDERR_LIMIT = 1000;
const MODE_BLOCK_BYTES = 1024 * 1024;
// Hub config.ts launchSchema default.
const DEFAULT_TIMEOUT_SEC = 90;
const MS_PER_SECOND = 1000;
const MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
const ACCOUNT = /^[\w.@-]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_SPECIAL = /["%&|<>^]/;

type Launch = { command: string[]; timeoutSec: number };
type LaunchResult = { session: string; pid: number; mode: string | null; account: number | null };
type SpawnLaunch = (command: string[]) => Promise<ApiResult<null>>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validMode = (value: string): boolean => MODES.some((mode) => mode === value);
const invalid = (message: string): ApiResult<never> => apiFail(LAUNCH_INVALID, message);

export const expandLaunch = async (runtime: RuntimePorts, launch: Launch, session: SessionRecord, account: string, mode: string | null): Promise<ApiResult<string[]>> => {
	const m = messagesFor(runtime.language).session;
	if (!SESSION_ID.test(session.id)) return invalid(m.launchSessionId());
	if (account !== "" && !ACCOUNT.test(account)) return invalid(m.launchAccount());
	if (mode !== null && !validMode(mode)) return invalid(m.launchMode());
	if (mode !== null && !launch.command.some((part) => part.includes("{mode}"))) return invalid(m.launchModePlaceholder());
	if (session.cwd === null || (runtime.platform === "windows" && WINDOWS_SPECIAL.test(session.cwd))) return invalid(m.launchDirectory());
	try { await runtime.fs.listDirectory(session.cwd); } catch { return invalid(m.launchDirectoryMissing()); }
	const cwd = session.cwd;
	const modeArg = mode === null ? "" : `--permission-mode ${mode}`;
	return apiOk(launch.command.flatMap((part) => {
		if (part === "{mode}") return mode === null ? [] : ["--permission-mode", mode];
		const expanded = part.replaceAll("{cwd}", cwd).replaceAll("{account}", account).replaceAll("{session}", session.id).replaceAll("{mode}", modeArg);
		return expanded === "" ? [] : [expanded];
	}));
};

export const transcriptMode = async (runtime: RuntimePorts, path: string | null): Promise<string | null> => {
	if (path === null) return null;
	try {
		const stat = await runtime.fs.stat(path);
		if (stat === null) return null;
		let end = stat.size;
		let suffix = Buffer.alloc(0);
		while (end > 0) {
			const start = Math.max(0, end - MODE_BLOCK_BYTES);
			const block = Buffer.concat([await runtime.fs.readRange(path, start, end - start), suffix]);
			const boundary = start === 0 ? 0 : block.indexOf("\n") + 1;
			if (start !== 0 && boundary === 0) { suffix = block; end = start; continue; }
			for (const line of block.subarray(boundary).toString("utf8").split("\n").reverse()) {
				let value: unknown;
				try { value = JSON.parse(line); } catch { continue; }
				if (object(value) && value.type === "permission-mode" && typeof value.permissionMode === "string") return value.permissionMode === "default" ? "manual" : value.permissionMode;
			}
			suffix = block.subarray(0, boundary);
			end = start;
		}
	} catch { return null; }
	return null;
};

const readLaunch = async (runtime: RuntimePorts): Promise<ApiResult<Launch>> => {
	const path = joinPath(runtime.home, ".agent-rig", "launch.json");
	try {
		const value: unknown = JSON.parse(await runtime.fs.readText(path));
		if (object(value) && Array.isArray(value.command) && value.command.length > 0 && value.command.every((part: unknown) => typeof part === "string") && (value.timeoutSec === undefined || (typeof value.timeoutSec === "number" && Number.isFinite(value.timeoutSec) && value.timeoutSec > 0))) {
			const command: string[] = value.command.filter((part: unknown): part is string => typeof part === "string");
			return apiOk({ command, timeoutSec: typeof value.timeoutSec === "number" ? value.timeoutSec : DEFAULT_TIMEOUT_SEC });
		}
	} catch { /* Missing or invalid configuration has one actionable error. */ }
	return apiFail(LAUNCH_NOT_CONFIGURED, messagesFor(runtime.language).session.launchConfigured(path));
};

export const runSession = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null, spawnCommand: SpawnLaunch = async (command) => { const result = await runtime.process.spawnDetached(command, LAUNCH_EXIT_GRACE_MS, STDERR_LIMIT); if (!result.ok) return apiFail(LAUNCH_FAILED, result.error); return !result.value.exited || result.value.exitCode === 0 ? apiOk(null) : apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.launchExited(result.value.exitCode, result.value.stderr)); }): Promise<ApiResult<LaunchResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (live.value) return apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning());
	const launch = await readLaunch(runtime);
	if (!launch.ok) return launch;
	let accountText = accountOverride ?? "";
	if (accountOverride === null) {
		const state = await readRigState(runtime);
		if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
		let record: unknown;
		try { record = JSON.parse(await runtime.fs.readText(joinPath(runtime.home, ".agent-rig", "sessions", `${session.id}.json`))); } catch { record = null; }
		const account = await accountOf(runtime, state.value, object(record) && typeof record.config_dir === "string" ? record.config_dir : "");
		accountText = account === null ? "" : String(account);
	}
	if (accountText !== "" && !/^\d+$/.test(accountText)) return invalid(messagesFor(runtime.language).session.accountNumber());
	const command = await expandLaunch(runtime, launch.value, session, accountText, mode);
	if (!command.ok) return command;
	const spawned = await spawnCommand(command.value);
	if (!spawned.ok) return spawned;
	const deadline = runtime.clock.now().getTime() + launch.value.timeoutSec * MS_PER_SECOND;
	for (;;) {
		const current = await lookupSession(runtime, session.id);
		if (!current.ok) return current;
		if (current.value.pid !== null && (current.value.pid !== session.pid || current.value.pidCreated !== session.pidCreated)) {
			const currentLive = await sessionLive(runtime, current.value);
			if (!currentLive.ok) return currentLive;
			if (currentLive.value) return apiOk({ session: session.id, pid: current.value.pid, mode, account: accountText === "" ? null : Number(accountText) });
		}
		const remaining = deadline - runtime.clock.now().getTime();
		if (remaining <= 0) return apiFail(LAUNCH_TIMEOUT, messagesFor(runtime.language).session.launchTimeout());
		await runtime.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
	}
};

export const runCommand = async (runtime: RuntimePorts, args: readonly string[]): Promise<ApiResult<LaunchResult>> => {
	const [id, ...flags] = args;
	if (!id) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageRun());
	let mode: string | null = null;
	let account: string | null = null;
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!value || (flag === "--mode" && mode !== null) || (flag === "--account" && account !== null) || (flag !== "--mode" && flag !== "--account")) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.invalidRunArguments());
		if (flag === "--mode") mode = value; else account = value;
	}
	const session = await lookupSessionForCommand(runtime, id, false);
	if (!session.ok) return session;
	return runSession(runtime, session.value, mode ?? await transcriptMode(runtime, session.value.transcriptPath), account);
};

export const modeCommand = async (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<{ session: string; mode: string; changed: false } | { session: string; mode: string; pid: number }>> => {
	if (args.length !== 2) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageMode());
	const [id, mode] = args;
	if (!validMode(mode)) return invalid(messagesFor(runtime.language).session.launchMode());
	const session = await lookupSessionForCommand(runtime, id, false);
	if (!session.ok) return session;
	if (await transcriptMode(runtime, session.value.transcriptPath) === mode) return apiOk({ session: id, mode, changed: false });
	const launch = await readLaunch(runtime);
	if (!launch.ok) return launch;
	const checked = await expandLaunch(runtime, launch.value, session.value, "", mode);
	if (!checked.ok) return checked;
	const stopped = await stopSession(runtime, session.value, progress);
	if (!stopped.ok) return stopped;
	const result = await runSession(runtime, session.value, mode, null);
	return result.ok ? apiOk({ session: id, mode, pid: result.value.pid }) : result;
};
