import type { Language, Messages } from "../messages.js";
import type { Result } from "../result.js";

import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, ptr } from "bun:ffi";

import { isLanguage, messagesFor } from "../messages.js";
import { err, errorText, ok } from "../result.js";

// Detached processes on Windows that outlive the job of whoever starts them.
//
// A process started detached stays in the job object of its parent, and the end of that job kills it. The hub runs as a
// Scheduled Task, and Stop-ScheduledTask (rig update restarts the hub) ends the task's whole job. So a run, a launched
// session or the restart step started from a hub-owned process must not stay in that job.
//
// 1. CREATE_BREAKAWAY_FROM_JOB puts the new process outside the job. It works when there is no job or the job sets
//    JOB_OBJECT_LIMIT_BREAKAWAY_OK, and fails with ERROR_ACCESS_DENIED otherwise.
// 2. A Scheduled Task's job has no limit flags at all, so breakaway is denied there (measured: IsProcessInJob true, limit
//    flags 0). Then a broker creates the process: WMI Win32_Process.Create starts it under the WMI service, outside the
//    task's job and unaffected by Stop-ScheduledTask (measured), and that process's own job sets BREAKAWAY_OK and
//    SILENT_BREAKAWAY_OK (limit flags 0x1800), so it starts the real process with step 1. WMI passes no environment,
//    so the environment travels in a spec file that the broker reads and deletes.

// Win32 creation flags (CreateProcessW).
const DETACHED_PROCESS = 0x8;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const ERROR_ACCESS_DENIED = 5;
// STARTUPINFO flags and show-window values.
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const SW_HIDE = 0;
const SW_SHOWDEFAULT = 10;
// Handle and file constants.
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ_WRITE = 0x3;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const WIN32_FALSE = 0;
const WIN32_TRUE = 1;
// x64 layouts: STARTUPINFOW is 104 bytes, STARTUPINFOEXW appends the attribute-list pointer; PROCESS_INFORMATION is 24
// bytes; SECURITY_ATTRIBUTES is 24 bytes.
const STARTUPINFOEX_SIZE = 112;
const PROCESS_INFORMATION_SIZE = 24;
const SECURITY_ATTRIBUTES_SIZE = 24;
const STARTUPINFO_FLAGS_OFFSET = 60;
const STARTUPINFO_SHOW_WINDOW_OFFSET = 64;
const STARTUPINFO_STDIN_OFFSET = 80;
const STARTUPINFO_STDOUT_OFFSET = 88;
const STARTUPINFO_STDERR_OFFSET = 96;
const STARTUPINFO_ATTRIBUTE_LIST_OFFSET = 104;
const SECURITY_ATTRIBUTES_INHERIT_OFFSET = 16;
const PROCESS_INFORMATION_PROCESS_ID_OFFSET = 16;
const POINTER_SIZE = 8;
const NUL_DEVICE = "NUL";
// How often the exit of a just-started process is checked while its grace period runs.
const EXIT_POLL_MS = 25;
// Time allowed for the broker beyond the grace period: powershell and Bun start cold, and WMI answers late on a busy host.
const BROKER_START_ALLOWANCE_MS = 30_000;
const BROKER_POLL_MS = 50;
const BROKER_SPEC_SUFFIX = ".broker-spec.json";
const BROKER_RESULT_SUFFIX = ".broker-result.json";
const BROKER_RESULT_TEMP_SUFFIX = ".tmp";
const BROKER_COMMAND_VARIABLE = "RIG_BROKER_COMMAND";
// One line, no double quotes: the command line of the process to create comes from the environment variable.
const BROKER_POWERSHELL = `$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:${BROKER_COMMAND_VARIABLE}; ProcessStartupInformation=$s}; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine('Win32_Process.Create returned ' + $r.ReturnValue); exit 1 }`;
const BROKER_SCRIPT = fileURLToPath(new URL("./windows-spawn-broker.ts", import.meta.url));

export type DetachedOutcome = { exited: boolean; exitCode: number | null; stderr: string; pid?: number };

export type DetachedRequest = {
	command: readonly string[];
	graceMs: number;
	stderrLimit: number;
	// Where the process's stderr goes; stdin and stdout are the NUL device.
	stderrPath: string;
	// Hide the window the process would show; it is detached either way (no console of its own).
	hide: boolean;
	// The complete environment of the new process; Windows needs it explicit (the broker passes none).
	environment: Record<string, string | undefined>;
	// The language of the failure texts; the broker runs in another process and builds its own catalogue from it.
	language: Language;
};

type OutsideJobProcess = { pid: number; handle: bigint };
type OutsideJobStart = { kind: "started"; process: OutsideJobProcess } | { kind: "denied" } | { kind: "failed"; error: string };

let loaded: ReturnType<typeof load> | null = null;
const load = () => dlopen("kernel32.dll", {
	CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
	GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
	GetLastError: { args: [], returns: FFIType.u32 },
});
const kernel = () => { loaded ??= load(); return loaded; };
type Kernel = ReturnType<typeof kernel>;

const wide = (text: string): Uint8Array => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));

// CommandLineToArgvW rules, the same quoting libuv applies to the arguments of a spawned child: an argument with a
// space, tab or quote is wrapped in quotes, quotes inside are escaped, and backslashes before a quote are doubled.
export const quoteWindowsArgument = (argument: string): string => {
	if (argument.length === 0) return "\"\"";
	if (!/[ \t"]/.test(argument)) return argument;
	let quoted = "\"";
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") { backslashes += 1; continue; }
		if (character === "\"") quoted += "\\".repeat(backslashes * 2 + 1) + "\"";
		else quoted += "\\".repeat(backslashes) + character;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

// NAME=VALUE entries, each ending in NUL, the block ending in one more NUL; names sorted case-insensitively as Windows expects.
const environmentBlock = (environment: Record<string, string | undefined>): Uint8Array => {
	const entries = Object.entries(environment).flatMap(([name, value]): [string, string][] => value === undefined ? [] : [[name, value]]).sort(([left], [right]) => left.toUpperCase() < right.toUpperCase() ? -1 : left.toUpperCase() > right.toUpperCase() ? 1 : 0);
	return new Uint8Array(Buffer.from(`${entries.map(([name, value]) => `${name}=${value}\0`).join("")}\0`, "utf16le"));
};

const inheritableAttributes = (): Uint8Array => {
	const attributes = new Uint8Array(SECURITY_ATTRIBUTES_SIZE);
	const view = new DataView(attributes.buffer);
	view.setUint32(0, SECURITY_ATTRIBUTES_SIZE, true);
	view.setInt32(SECURITY_ATTRIBUTES_INHERIT_OFFSET, WIN32_TRUE, true);
	return attributes;
};

const openInheritable = (api: Kernel, path: string, access: number, disposition: number, messages: Messages): Result<bigint> => {
	const handle = api.symbols.CreateFileW(ptr(wide(path)), access, FILE_SHARE_READ_WRITE, ptr(inheritableAttributes()), disposition, FILE_ATTRIBUTE_NORMAL, 0n);
	return handle === INVALID_HANDLE_VALUE ? err(messages.failure.win32CallFailed(`CreateFileW ${path}`, api.symbols.GetLastError())) : ok(handle);
};

// Step 1: CreateProcessW with CREATE_BREAKAWAY_FROM_JOB and only stdin, stdout and stderr inherited (the caller's other
// inheritable handles, such as its own pipes, must not leak into a process that outlives it, or a reader of those pipes
// would wait for it).
const startOutsideJob = (request: DetachedRequest): OutsideJobStart => {
	const handles: bigint[] = [];
	let api: Kernel | undefined;
	try {
		const opened = kernel();
		const messages = messagesFor(request.language);
		api = opened;
		const stdin = openInheritable(opened, NUL_DEVICE, GENERIC_READ, OPEN_EXISTING, messages);
		if (!stdin.ok) return { kind: "failed", error: stdin.error };
		handles.push(stdin.value);
		const stdout = openInheritable(opened, NUL_DEVICE, GENERIC_WRITE, OPEN_EXISTING, messages);
		if (!stdout.ok) return { kind: "failed", error: stdout.error };
		handles.push(stdout.value);
		const stderr = openInheritable(opened, request.stderrPath, GENERIC_WRITE, CREATE_ALWAYS, messages);
		if (!stderr.ok) return { kind: "failed", error: stderr.error };
		handles.push(stderr.value);
		return createProcess(opened, request, handles);
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	} finally {
		if (api !== undefined) for (const handle of handles) api.symbols.CloseHandle(handle);
	}
};

const createProcess = (api: Kernel, request: DetachedRequest, inherited: readonly bigint[]): OutsideJobStart => {
	const messages = messagesFor(request.language);
	const handleList = new Uint8Array(inherited.length * POINTER_SIZE);
	const listView = new DataView(handleList.buffer);
	inherited.forEach((handle, index) => { listView.setBigUint64(index * POINTER_SIZE, handle, true); });
	const sizeBuffer = new BigUint64Array(1);
	// The first call only reports the size the attribute list needs.
	api.symbols.InitializeProcThreadAttributeList(null, 1, 0, ptr(sizeBuffer));
	const attributeList = new Uint8Array(Number(sizeBuffer[0] ?? 0n));
	if (api.symbols.InitializeProcThreadAttributeList(ptr(attributeList), 1, 0, ptr(sizeBuffer)) === WIN32_FALSE) return { kind: "failed", error: messages.failure.win32CallFailed("InitializeProcThreadAttributeList", api.symbols.GetLastError()) };
	try {
		if (api.symbols.UpdateProcThreadAttribute(ptr(attributeList), 0, BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), ptr(handleList), BigInt(handleList.length), null, null) === WIN32_FALSE) return { kind: "failed", error: messages.failure.win32CallFailed("UpdateProcThreadAttribute", api.symbols.GetLastError()) };
		const [stdin, stdout, stderr] = inherited;
		const startup = new Uint8Array(STARTUPINFOEX_SIZE);
		const view = new DataView(startup.buffer);
		view.setUint32(0, STARTUPINFOEX_SIZE, true);
		view.setUint32(STARTUPINFO_FLAGS_OFFSET, STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, true);
		view.setUint16(STARTUPINFO_SHOW_WINDOW_OFFSET, request.hide ? SW_HIDE : SW_SHOWDEFAULT, true);
		view.setBigUint64(STARTUPINFO_STDIN_OFFSET, stdin ?? 0n, true);
		view.setBigUint64(STARTUPINFO_STDOUT_OFFSET, stdout ?? 0n, true);
		view.setBigUint64(STARTUPINFO_STDERR_OFFSET, stderr ?? 0n, true);
		view.setBigUint64(STARTUPINFO_ATTRIBUTE_LIST_OFFSET, BigInt(ptr(attributeList)), true);
		const commandLine = wide(request.command.map(quoteWindowsArgument).join(" "));
		const environment = environmentBlock(request.environment);
		const information = new Uint8Array(PROCESS_INFORMATION_SIZE);
		const flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
		if (api.symbols.CreateProcessW(null, ptr(commandLine), null, null, WIN32_TRUE, flags, ptr(environment), null, ptr(startup), ptr(information)) === WIN32_FALSE) {
			const code = api.symbols.GetLastError();
			return code === ERROR_ACCESS_DENIED ? { kind: "denied" } : { kind: "failed", error: messages.failure.win32CallFailed("CreateProcessW", code) };
		}
		const result = new DataView(information.buffer);
		api.symbols.CloseHandle(result.getBigUint64(POINTER_SIZE, true));
		return { kind: "started", process: { pid: result.getUint32(PROCESS_INFORMATION_PROCESS_ID_OFFSET, true), handle: result.getBigUint64(0, true) } };
	} finally {
		api.symbols.DeleteProcThreadAttributeList(ptr(attributeList));
	}
};

// The exit code of the process, or null while it still runs.
const exitCodeOf = (process: OutsideJobProcess, messages: Messages): Result<number | null> => {
	const api = kernel();
	const state = api.symbols.WaitForSingleObject(process.handle, 0);
	if (state === WAIT_TIMEOUT) return ok(null);
	if (state !== WAIT_OBJECT_0) return err(messages.failure.win32CallFailed("WaitForSingleObject", api.symbols.GetLastError()));
	const code = new Uint32Array(1);
	if (api.symbols.GetExitCodeProcess(process.handle, ptr(code)) === WIN32_FALSE) return err(messages.failure.win32CallFailed("GetExitCodeProcess", api.symbols.GetLastError()));
	return ok(code[0] ?? 0);
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const readStderr = (path: string, limit: number): string => {
	try { return readFileSync(path, "utf8").trim().slice(0, limit); } catch { return ""; }
};

// Waits up to the grace period for the process to exit: an exit inside it is reported with its code and stderr, a process
// still running after it is reported as started.
const awaitGrace = async (process: OutsideJobProcess, request: DetachedRequest): Promise<Result<DetachedOutcome>> => {
	const deadline = Date.now() + request.graceMs;
	const messages = messagesFor(request.language);
	try {
		for (;;) {
			const code = exitCodeOf(process, messages);
			if (!code.ok) return code;
			if (code.value !== null) return ok({ exited: true, exitCode: code.value, stderr: code.value === 0 ? "" : readStderr(request.stderrPath, request.stderrLimit), pid: process.pid });
			if (Date.now() >= deadline) return ok({ exited: false, exitCode: null, stderr: "", pid: process.pid });
			await sleep(Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now())));
		}
	} finally {
		kernel().symbols.CloseHandle(process.handle);
	}
};

/**
 * Starts the command detached and outside the caller's job object, and reports its exit if it ends within the grace
 * period. Uses the broker when the caller's job forbids breakaway.
 */
export const spawnDetachedWindows = async (request: DetachedRequest): Promise<Result<DetachedOutcome>> => {
	if (request.command.length === 0) return err(messagesFor(request.language).failure.emptyLaunchCommand());
	const started = startOutsideJob(request);
	if (started.kind === "failed") return err(started.error);
	if (started.kind === "started") return await awaitGrace(started.process, request);
	return await spawnThroughBroker(request);
};

type BrokerSpec = { request: DetachedRequest; resultPath: string };

const spawnThroughBroker = async (request: DetachedRequest): Promise<Result<DetachedOutcome>> => {
	const messages = messagesFor(request.language);
	const specPath = `${request.stderrPath}${BROKER_SPEC_SUFFIX}`;
	const resultPath = `${request.stderrPath}${BROKER_RESULT_SUFFIX}`;
	const cleanup = (): void => {
		for (const path of [specPath, resultPath, `${resultPath}${BROKER_RESULT_TEMP_SUFFIX}`]) rmSync(path, { force: true });
	};
	try {
		cleanup();
		const spec: BrokerSpec = { request, resultPath };
		writeFileSync(specPath, JSON.stringify(spec));
		const brokerCommand = [process.execPath, BROKER_SCRIPT, specPath].map(quoteWindowsArgument).join(" ");
		const created = await runBrokerLauncher(brokerCommand, messages);
		if (!created.ok) return created;
		const deadline = Date.now() + request.graceMs + BROKER_START_ALLOWANCE_MS;
		for (;;) {
			let text: string | null = null;
			try { text = readFileSync(resultPath, "utf8"); } catch { /* The broker has not answered yet. */ }
			if (text !== null) return parseBrokerResult(text, messages);
			if (Date.now() >= deadline) return err(messages.failure.brokerNoAnswer());
			await sleep(BROKER_POLL_MS);
		}
	} catch (error) {
		return err(errorText(error));
	} finally {
		cleanup();
	}
};

// Asks WMI (through a short-lived powershell) to create the broker process, which then lives outside the caller's job.
const runBrokerLauncher = (brokerCommand: string, messages: Messages): Promise<Result<void>> => new Promise((resolve) => {
	let stderr = "";
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", BROKER_POWERSHELL], {
		env: { ...process.env, [BROKER_COMMAND_VARIABLE]: brokerCommand },
		windowsHide: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	child.once("error", (error) => { resolve(err(error.message)); });
	child.once("close", (code) => { resolve(code === 0 ? ok(undefined) : err(stderr.trim() || messages.failure.powershellExited(code))); });
});

const isOutcome = (value: unknown): value is DetachedOutcome =>
	typeof value === "object" && value !== null && "exited" in value && typeof value.exited === "boolean" && "stderr" in value && typeof value.stderr === "string";

const parseBrokerResult = (text: string, messages: Messages): Result<DetachedOutcome> => {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") return err(parsed.error);
		if (typeof parsed === "object" && parsed !== null && "outcome" in parsed && isOutcome(parsed.outcome)) return ok(parsed.outcome);
		return err(messages.failure.brokerInvalidResult());
	} catch (error) {
		return err(errorText(error));
	}
};

/** The broker process: reads its spec, starts the real process outside every job, writes the outcome, exits. */
export const runBroker = async (specPath: string): Promise<number> => {
	let resultPath = "";
	try {
		const spec: unknown = JSON.parse(readFileSync(specPath, "utf8"));
		rmSync(specPath, { force: true });
		if (typeof spec !== "object" || spec === null || !("request" in spec) || !("resultPath" in spec) || typeof spec.resultPath !== "string") return 1;
		resultPath = spec.resultPath;
		const request = spec.request;
		if (!isRequest(request)) return 1;
		const started = startOutsideJob(request);
		let result: { outcome: DetachedOutcome } | { error: string };
		if (started.kind === "started") {
			const outcome = await awaitGrace(started.process, request);
			result = outcome.ok ? { outcome: outcome.value } : { error: outcome.error };
		} else {
			result = { error: started.kind === "denied" ? messagesFor(request.language).failure.brokerForbidsBreakaway() : started.error };
		}
		const temporary = `${resultPath}${BROKER_RESULT_TEMP_SUFFIX}`;
		writeFileSync(temporary, JSON.stringify(result));
		renameSync(temporary, resultPath);
		return 0;
	} catch (error) {
		if (resultPath !== "") { try { writeFileSync(`${resultPath}${BROKER_RESULT_TEMP_SUFFIX}`, JSON.stringify({ error: errorText(error) })); renameSync(`${resultPath}${BROKER_RESULT_TEMP_SUFFIX}`, resultPath); } catch { /* The caller times out. */ } }
		return 1;
	}
};

const isRequest = (value: unknown): value is DetachedRequest =>
	typeof value === "object" && value !== null
	&& "command" in value && Array.isArray(value.command) && value.command.every((part) => typeof part === "string")
	&& "graceMs" in value && typeof value.graceMs === "number"
	&& "stderrLimit" in value && typeof value.stderrLimit === "number"
	&& "stderrPath" in value && typeof value.stderrPath === "string"
	&& "hide" in value && typeof value.hide === "boolean"
	&& "environment" in value && typeof value.environment === "object" && value.environment !== null
	&& "language" in value && isLanguage(value.language);
