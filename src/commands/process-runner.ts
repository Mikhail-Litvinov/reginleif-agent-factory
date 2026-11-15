import type { Result } from "../result.js";
import type { ProcessOptions, ProcessOutput } from "../ports.js";

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { platform as hostPlatform, tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { err, errorText, ok } from "../result.js";
import { PROCESS_FAILURE_EXIT_CODE } from "../ports.js";

// An external command (git, claude plugin) that hangs is killed after 15 minutes and counts as failed.
const MINUTES_PER_TIMEOUT = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1000;
export const PROCESS_TIMEOUT_MS = MINUTES_PER_TIMEOUT * MILLISECONDS_PER_MINUTE;
// Order in which Windows resolves a bare command name that has no extension.
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"] as const;
const WINDOWS_SCRIPT_EXTENSIONS = [".cmd", ".bat"] as const;
const WINDOWS_PATH_SEPARATOR = ";";
// cmd.exe expands %VAR% even inside double quotes and cannot escape a double quote there.
const CMD_UNSAFE_ARGUMENT = /["%\r\n]/;

export const spawnDetached = async (command: readonly string[], graceMs: number, stderrLimit: number): Promise<Result<{ exited: boolean; exitCode: number | null; stderr: string }>> => {
	const [executable, ...args] = command;
	if (!executable) return err("Empty launch command");
	let directory: string;
	try { directory = mkdtempSync(join(tmpdir(), "rig-launch-")); } catch (error) { return err(errorText(error)); }
	const path = join(directory, "stderr");
	const cleanup = (): void => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows can retain the child handle. */ } };
	try {
		const fd = openSync(path, "w");
		let child;
		try { child = spawn(executable, args, { detached: true, stdio: ["ignore", "ignore", fd] }); } finally { closeSync(fd); }
		return await new Promise((resolve) => {
			let settled = false;
			const finish = (result: Result<{ exited: boolean; exitCode: number | null; stderr: string }>): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.unref();
				resolve(result);
			};
			const timer = setTimeout(() => finish(ok({ exited: false, exitCode: null, stderr: "" })), graceMs);
			child.once("error", (error) => { cleanup(); finish(err(error.message)); });
			child.once("exit", (code) => {
				let stderr = "";
				if (!settled && code !== 0) { try { stderr = readFileSync(path, "utf8").trim().slice(0, stderrLimit); } catch { /* No stderr available. */ } }
				cleanup();
				finish(ok({ exited: true, exitCode: code, stderr }));
			});
		});
	} catch (error) { cleanup(); return err(errorText(error)); }
};

export type RunnerKind = "windows" | "posix";
// start() arms a one-shot timer and returns a function that disarms it.
export type ProcessTimer = { start(milliseconds: number, onExpire: () => void): () => void };
export type ProcessKiller = (child: ReturnType<typeof spawn>, kind: RunnerKind) => Promise<void>;
export type ProcessLimits = { timeoutMs: number; timer: ProcessTimer; kill?: ProcessKiller };
export type SpawnPlan = { command: string; args: string[]; verbatim: boolean };

const realTimer: ProcessTimer = {
	start: (milliseconds, onExpire) => {
		const handle = setTimeout(onExpire, milliseconds);
		return () => clearTimeout(handle);
	},
};
export const DEFAULT_PROCESS_LIMITS: ProcessLimits = { timeoutMs: PROCESS_TIMEOUT_MS, timer: realTimer };

const hasExtension = (command: string, extensions: readonly string[]): boolean =>
	extensions.some((extension) => command.toLowerCase().endsWith(extension));

const resolveWindowsCommand = (command: string, pathEnvironment: string, exists: (path: string) => boolean): string => {
	const hasDirectory = command.includes("/") || command.includes("\\");
	const directories = hasDirectory ? [""] : pathEnvironment.split(WINDOWS_PATH_SEPARATOR).filter((directory) => directory.length > 0);
	// A bare name is not itself runnable on Windows, only its suffixed forms are.
	const extensions = hasExtension(command, WINDOWS_EXECUTABLE_EXTENSIONS) ? [""] : WINDOWS_EXECUTABLE_EXTENSIONS;
	for (const directory of directories) {
		for (const extension of extensions) {
			// win32.join: this branch always describes Windows paths, whatever host runs it.
			const candidate = `${directory.length > 0 ? win32.join(directory, command) : command}${extension}`;
			if (exists(candidate)) return candidate;
		}
	}
	return command;
};

const quoteForCmd = (value: string): string => `"${value}"`;

// Decides how to start a command. A .cmd or .bat file (npm.cmd, claude.cmd) cannot be spawned directly on Windows, so it
// runs through cmd.exe with every argument quoted; nothing else ever goes through a shell.
export const planSpawn = (
	kind: RunnerKind,
	command: string,
	args: readonly string[],
	pathEnvironment: string,
	exists: (path: string) => boolean = existsSync,
): Result<SpawnPlan> => {
	if (kind === "posix") return ok({ command, args: [...args], verbatim: false });
	const resolved = resolveWindowsCommand(command, pathEnvironment, exists);
	if (!hasExtension(resolved, WINDOWS_SCRIPT_EXTENSIONS)) return ok({ command: resolved, args: [...args], verbatim: false });
	const parts = [resolved, ...args];
	const unsafe = parts.find((part) => CMD_UNSAFE_ARGUMENT.test(part));
	if (unsafe !== undefined) return err(`Cannot pass ${JSON.stringify(unsafe)} to ${command} through cmd.exe: it contains a quote, percent sign or line break.`);
	return ok({ command: "cmd.exe", args: ["/d", "/s", "/c", `"${parts.map(quoteForCmd).join(" ")}"`], verbatim: true });
};

const describeDuration = (milliseconds: number): string =>
	milliseconds >= MILLISECONDS_PER_MINUTE
		? `${Math.round(milliseconds / MILLISECONDS_PER_MINUTE)} minutes`
		: `${Math.round(milliseconds / MILLISECONDS_PER_SECOND)} seconds`;

// Kills the child and its descendants by PID (taskkill /T on Windows, the process group elsewhere), never by image name.
const killTree: ProcessKiller = (child, kind) => new Promise((resolveKill) => {
	const pid = child.pid;
	if (pid === undefined) {
		resolveKill();
		return;
	}
	if (kind === "windows") {
		const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => resolveKill());
		killer.on("close", () => resolveKill());
		return;
	}
	try {
		// The child leads its own process group (detached), so a negative pid reaches every descendant.
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	resolveKill();
});

export const runProcess = (
	pathEnvironment: string,
	command: string,
	args: readonly string[],
	options: ProcessOptions = {},
	limits: ProcessLimits = DEFAULT_PROCESS_LIMITS,
	kind: RunnerKind = hostPlatform() === "win32" ? "windows" : "posix",
): Promise<Result<ProcessOutput>> => new Promise((resolveResult) => {
	const plan = planSpawn(kind, command, args, pathEnvironment);
	if (!plan.ok) {
		resolveResult(plan);
		return;
	}
	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;
	let disarm: () => void = () => undefined;
	const timeoutMs = options.timeoutMs ?? limits.timeoutMs;
	const timeoutFailure = (): Result<ProcessOutput> => err(`${command} did not finish within ${describeDuration(timeoutMs)} and was killed.`);
	const settle = (result: Result<ProcessOutput>): void => {
		if (settled) return;
		settled = true;
		disarm();
		resolveResult(result);
	};
	try {
		const environment: Record<string, string | undefined> = { ...process.env, PATH: pathEnvironment };
		// Without this git waits for a password on the terminal and hangs an unattended update.
		if (command === "git") environment.GIT_TERMINAL_PROMPT = "0";
		Object.assign(environment, options.environment);
		const child = spawn(plan.value.command, plan.value.args, {
			cwd: options.cwd,
			env: environment,
			windowsHide: true,
			windowsVerbatimArguments: plan.value.verbatim,
			detached: kind === "posix",
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: unknown) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
		child.on("error", (error) => settle(err(errorText(error))));
		// The killed child can report close before the killer returns, and that exit is still the timeout.
		child.on("close", (code) => settle(timedOut ? timeoutFailure() : ok({ stdout, stderr, exitCode: code ?? PROCESS_FAILURE_EXIT_CODE })));
		disarm = limits.timer.start(timeoutMs, () => {
			if (settled) return;
			timedOut = true;
			void (limits.kill ?? killTree)(child, kind).then(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				settle(timeoutFailure());
			});
		});
		if (options.input === undefined) child.stdin.end();
		else child.stdin.end(options.input);
	} catch (error) {
		settle(err(errorText(error)));
	}
});
