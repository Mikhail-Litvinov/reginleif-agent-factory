import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { localPluginOrigin, readMarketplaceManifest } from "../apply.js";
import { findOnPath } from "../executable-path.js";
import { readFeature } from "../feature.js";
import { joinPath } from "../file-system.js";
import { buildLaunchCommand } from "../launch-command.js";
import { launchPath, LAUNCH_TOKEN } from "../launch-safety.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, LAUNCH_FAILED, LAUNCH_ACCOUNT_LOOKUP, LAUNCH_INVALID, LAUNCH_UNAVAILABLE, LAUNCH_TIMEOUT, SESSION_RUNNING } from "../output.js";
import { errorText } from "../result.js";
import { lookupSession, lookupSessionForCommand, sessionLive, SESSION_POLL_MS } from "../session-core.js";
import { accountOf, INFO_ERROR_STATE_UNREADABLE } from "./info.js";
import { readRigState } from "./shared.js";
import { stopSession } from "./session-stop.js";

// How long a launch waits to see whether its process exits at once (ms); the launch file is removed only once older than this.
const LAUNCH_EXIT_GRACE_MS = 2000;
// Most stderr bytes a failed launch returns.
const STDERR_LIMIT = 1000;
// The transcript's mode is searched backwards in blocks of this size (1 MiB).
const MODE_BLOCK_BYTES = 1024 * 1024;
// Seconds a session run waits when the command gives no timeout of its own.
const DEFAULT_TIMEOUT_SEC = 90;
const POSIX_PATH_SEPARATOR = ":";
const WINDOWS_PATH_SEPARATOR = ";";
// File types cmd.exe /c tries for a bare name, in its lookup order; PATH order comes first.
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat"] as const;
const MS_PER_SECOND = 1000;
const MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LaunchResult = { session: string; pid: number; mode: string | null; account: number | null };
type SpawnLaunch = (command: string[]) => Promise<ApiResult<null>>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validMode = (value: string): boolean => MODES.some((mode) => mode === value);
const invalid = (message: string): ApiResult<never> => apiFail(LAUNCH_INVALID, message);

// The full path of a launcher found on PATH, or null. The launch starts that path, not the bare name PATH would resolve again.
const launcherPath = async (runtime: RuntimePorts, name: string, suffixes: readonly string[] = [""]): Promise<string | null> => findOnPath(
	runtime.pathEnvironment,
	runtime.platform === "windows" ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR,
	(directory) => runtime.resolvePath(directory, name),
	async (path) => await runtime.fs.stat(path) !== null,
	suffixes,
);

// The one cswap lookup of a launch: the full path of the file that will run, or null. resolveLaunch does it once and
// hands the result to both the account decision and prepareLaunch, so the file checked is the file started. On Windows
// a .cmd or .bat shim counts, as cmd.exe /c runs it.
export const findCswap = async (runtime: RuntimePorts): Promise<string | null> => launcherPath(runtime, "cswap", runtime.platform === "windows" ? WINDOWS_EXECUTABLE_SUFFIXES : [""]);

export const prepareLaunch = async (runtime: RuntimePorts, session: SessionRecord, account: string, mode: string | null, cswapFound: string | null): Promise<ApiResult<string[]>> => {
	const m = messagesFor(runtime.language).session;
	if (!SESSION_ID.test(session.id)) return invalid(m.launchSessionId());
	if (account !== "" && !LAUNCH_TOKEN.test(account)) return invalid(m.launchAccount());
	if (mode !== null && !validMode(mode)) return invalid(m.launchMode());
	if (session.cwd === null) return invalid(m.launchDirectory());
	const cwd = launchPath(runtime.platform, session.cwd);
	if (!cwd.ok) return invalid(m.launchDirectory());
	try { await runtime.fs.listDirectory(session.cwd); } catch { return invalid(m.launchDirectoryMissing()); }
	const state = await readRigState(runtime);
	if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
	const plugins: string[] = [];
	if (state.value.features.telegram === true) {
		const feature = await readFeature(runtime.fs, joinPath(state.value.paths.repo, "features", "telegram"), messagesFor(runtime.language));
		if (!feature.ok) return invalid(feature.error);
		for (const plugin of feature.value.plugins) {
			const origin = localPluginOrigin(plugin, state.value.paths.hub, state.value.paths.repo);
			let id = plugin;
			if (origin !== null) {
				const marketplace = await readMarketplaceManifest(runtime.fs, origin.path, origin.label, messagesFor(runtime.language));
				if (!marketplace.ok) return invalid(marketplace.error);
				if (origin.mustBeListed && !marketplace.value.plugins.includes(origin.name)) return invalid(m.pluginMissingFromMarketplace(origin.name, marketplace.value.name));
				id = `${origin.name}@${marketplace.value.name}`;
			}
			if (!LAUNCH_TOKEN.test(id)) return invalid(m.launchPlugin());
			plugins.push(id);
		}
	}
	if (cswapFound === null && account !== "") return invalid(m.launchNoCswap());
	// The path goes onto the launch line like the directory does, so the same platform rules apply to it.
	const cswapOnLine = cswapFound === null ? null : launchPath(runtime.platform, cswapFound);
	if (cswapOnLine !== null && !cswapOnLine.ok) return apiFail(LAUNCH_UNAVAILABLE, m.launchCswapPath());
	const cswap = cswapOnLine === null ? null : cswapOnLine.value;
	const display = Boolean(runtime.environment.get("DISPLAY") || runtime.environment.get("WAYLAND_DISPLAY"));
	const terminal = runtime.platform === "linux" && display ? await launcherPath(runtime, "x-terminal-emulator") : null;
	const tmux = runtime.platform === "linux" && terminal === null ? await launcherPath(runtime, "tmux") : null;
	const command = buildLaunchCommand({ platform: runtime.platform, cwd: cwd.value, session: session.id, account, mode, plugins, cswap, terminal, tmux });
	return command === null ? apiFail(LAUNCH_UNAVAILABLE, m.launchUnavailable()) : apiOk(command);
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

const spawnLaunch = async (runtime: RuntimePorts, command: string[]): Promise<ApiResult<null>> => {
	const directory = joinPath(runtime.home, ".agent-rig", "launch-stderr");
	const now = runtime.clock.now().getTime();
	const path = joinPath(directory, `${now}-${runtime.ids.next()}.log`);
	try {
		await runtime.fs.ensureDirectory(directory);
		for (const entry of await runtime.fs.listDirectory(directory)) {
			const match = /^(\d+)-[\w-]+\.log$/.exec(entry.name);
			// A concurrent launch needs its stderr until its grace period has elapsed.
			if (!entry.directory && match && now - Number(match[1]) >= LAUNCH_EXIT_GRACE_MS) await runtime.fs.remove(joinPath(directory, entry.name)).catch(() => undefined);
		}
	} catch (error) { return apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.io(errorText(error))); }
	const result = await runtime.process.spawnDetached(command, LAUNCH_EXIT_GRACE_MS, STDERR_LIMIT, path);
	// On Windows the child may still hold the file; the next launch retries it.
	await runtime.fs.remove(path).catch(() => undefined);
	if (!result.ok) return apiFail(LAUNCH_FAILED, result.error);
	return !result.value.exited || result.value.exitCode === 0 ? apiOk(null) : apiFail(LAUNCH_FAILED, messagesFor(runtime.language).session.launchExited(result.value.exitCode, result.value.stderr));
};

type ResolvedLaunch = { command: string[]; account: string };

// The whole launch, account included, resolved into a Result before any destructive step. A failed account lookup
// matters only where cswap could use the account; without cswap the session starts as before 0.7.0, without one.
export const resolveLaunch = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null): Promise<ApiResult<ResolvedLaunch>> => {
	const m = messagesFor(runtime.language);
	const cswap = await findCswap(runtime);
	let accountText = accountOverride ?? "";
	if (accountOverride === null) {
		const state = await readRigState(runtime);
		if (!state.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, state.error);
		let record: unknown;
		try { record = JSON.parse(await runtime.fs.readText(joinPath(runtime.home, ".agent-rig", "sessions", `${session.id}.json`))); } catch { record = null; }
		const account = await accountOf(runtime, state.value, object(record) && typeof record.config_dir === "string" ? record.config_dir : "");
		if (account.ok) accountText = account.value === null ? "" : String(account.value);
		else if (cswap !== null) return apiFail(LAUNCH_ACCOUNT_LOOKUP, m.session.launchAccountLookup(account.error));
	}
	if (accountText !== "" && !/^\d+$/.test(accountText)) return invalid(m.session.accountNumber());
	const command = await prepareLaunch(runtime, session, accountText, mode, cswap);
	return command.ok ? apiOk({ command: command.value, account: accountText }) : command;
};

export const runSession = async (runtime: RuntimePorts, session: SessionRecord, mode: string | null, accountOverride: string | null, spawnCommand: SpawnLaunch = (command) => spawnLaunch(runtime, command)): Promise<ApiResult<LaunchResult>> => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (live.value) return apiFail(SESSION_RUNNING, messagesFor(runtime.language).session.alreadyRunning());
	const launch = await resolveLaunch(runtime, session, mode, accountOverride);
	if (!launch.ok) return launch;
	const accountText = launch.value.account;
	const spawned = await spawnCommand(launch.value.command);
	if (!spawned.ok) return spawned;
	const deadline = runtime.clock.now().getTime() + DEFAULT_TIMEOUT_SEC * MS_PER_SECOND;
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
	const launch = await resolveLaunch(runtime, session.value, mode, null);
	if (!launch.ok) return launch;
	const stopped = await stopSession(runtime, session.value, progress);
	if (!stopped.ok) return stopped;
	const result = await runSession(runtime, session.value, mode, launch.value.account);
	return result.ok ? apiOk({ session: id, mode, pid: result.value.pid }) : result;
};
