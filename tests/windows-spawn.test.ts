import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

import { quoteWindowsArgument } from "../src/commands/windows-spawn.js";

// Real-process tests of the Windows detached spawn: a stand-in for the hub (a process inside a job object) starts a
// detached child through rig's spawnDetached; the child must be outside that job and survive the job's end.
const ON_WINDOWS = process.platform === "win32";
const TEST_BOUND_MS = 90_000;
const POLL_MS = 50;
// Bound for the child to appear: a cold Bun start, plus the broker (powershell and WMI) when breakaway is denied.
const APPEAR_BOUND_MS = 60_000;
const GONE_BOUND_MS = 10_000;
const REMOVE_RETRIES = 40;
// Survival is shown by the child still running this long after its job was terminated.
const SURVIVAL_WINDOW_MS = 1500;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_EXTENDED_LIMIT_SIZE = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const JOB_LIMIT_NONE = 0;
// JOB_OBJECT_LIMIT_BREAKAWAY_OK (Win32 job object limit flags).
const JOB_LIMIT_BREAKAWAY_OK = 0x800;
const PROCESS_TERMINATE = 0x1;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// Needed to wait on a process handle.
const PROCESS_SYNCHRONIZE = 0x100000;
const WAIT_TIMEOUT = 0x102;
const TERMINATED_EXIT_CODE = 1;
const PARENT_SCRIPT = join(import.meta.dir, "helpers", "jobbed-parent.ts");
const CHILD_SCRIPT = join(import.meta.dir, "helpers", "job-child.ts");
const FAILING_CHILD_SCRIPT = join(import.meta.dir, "helpers", "job-child-fails.ts");
const FAILING_EXIT_CODE = 7;
const STDERR_MARKER = "child-failed-marker";

const kernel = ON_WINDOWS ? dlopen("kernel32.dll", {
	CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
	TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
	IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
}) : null;

const roots: string[] = [];
const spawnedPids = new Set<number>();
const makeRoot = (): string => { const root = mkdtempSync(join(tmpdir(), "rig-winspawn-")); roots.push(root); return root; };

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const waitFor = async (condition: () => boolean, boundMs: number): Promise<boolean> => {
	const deadline = Date.now() + boundMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(POLL_MS);
	}
	return condition();
};

const isAlive = (pid: number): boolean => {
	if (kernel === null) return false;
	const handle = kernel.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
	if (handle === 0n) return false;
	try { return kernel.symbols.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT; } finally { kernel.symbols.CloseHandle(handle); }
};

const killPid = (pid: number): void => {
	try { process.kill(pid); } catch { /* Already gone. */ }
};

afterEach(async () => {
	const pids = [...spawnedPids];
	spawnedPids.clear();
	for (const pid of pids) killPid(pid);
	// The processes hold files in the roots until they are really gone.
	await waitFor(() => pids.every((pid) => !isAlive(pid)), GONE_BOUND_MS);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: POLL_MS });
});

describe("quoteWindowsArgument", () => {
	test("leaves plain arguments alone and quotes the empty one", () => {
		expect(quoteWindowsArgument("plain")).toBe("plain");
		expect(quoteWindowsArgument("")).toBe("\"\"");
	});
	test("wraps spaces and escapes quotes and backslashes before them", () => {
		expect(quoteWindowsArgument("a b")).toBe("\"a b\"");
		expect(quoteWindowsArgument("a\"b")).toBe("\"a\\\"b\"");
		expect(quoteWindowsArgument("C:\\dir with space\\")).toBe("\"C:\\dir with space\\\\\"");
		expect(quoteWindowsArgument("a\\\"b")).toBe("\"a\\\\\\\"b\"");
	});
});

// Starts the stand-in parent inside a new job with the given limit flags, lets it spawn `childScript` through
// spawnDetached, and returns once it has recorded the outcome. The caller closes the job.
const startJobbedParent = async (limitFlags: number, childScript: string): Promise<{ job: bigint; parentPid: number; pidPath: string; outcome: unknown }> => {
	if (kernel === null) throw new Error("Windows only");
	const root = makeRoot();
	const goPath = join(root, "go");
	const resultPath = join(root, "result.json");
	const pidPath = join(root, "child-pid.txt");
	const job = kernel.symbols.CreateJobObjectW(null, null);
	expect(job).not.toBe(0n);
	const limits = new Uint8Array(JOB_OBJECT_EXTENDED_LIMIT_SIZE);
	new DataView(limits.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, limitFlags, true);
	expect(kernel.symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(limits), JOB_OBJECT_EXTENDED_LIMIT_SIZE)).toBe(1);
	const parent = spawn(process.execPath, [PARENT_SCRIPT, goPath, resultPath, childScript, pidPath, join(root, "stderr.log")], { stdio: "ignore", windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: "x", TELEGRAM_HUB_BOT_TOKEN: "x", ANTHROPIC_API_KEY: "x", RIG_KEEP_ME: "x" } });
	const parentPid = parent.pid;
	if (parentPid === undefined) throw new Error("The stand-in parent did not start");
	spawnedPids.add(parentPid);
	const parentHandle = kernel.symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, parentPid);
	expect(parentHandle).not.toBe(0n);
	expect(kernel.symbols.AssignProcessToJobObject(job, parentHandle)).toBe(1);
	kernel.symbols.CloseHandle(parentHandle);
	await Bun.write(goPath, "go");
	expect(await waitFor(() => existsSync(resultPath), APPEAR_BOUND_MS)).toBe(true);
	return { job, parentPid, pidPath, outcome: JSON.parse(readFileSync(resultPath, "utf8")) };
};

const runFailCheck = async (limitFlags: number): Promise<void> => {
	if (kernel === null) return;
	const started = await startJobbedParent(limitFlags, FAILING_CHILD_SCRIPT);
	try {
		expect(started.outcome).toMatchObject({ ok: true, value: { exited: true, exitCode: FAILING_EXIT_CODE } });
		expect(JSON.stringify(started.outcome)).toContain(STDERR_MARKER);
	} finally {
		kernel.symbols.CloseHandle(started.job);
	}
};

const runEscapeCheck = async (limitFlags: number): Promise<void> => {
	if (kernel === null) return;
	const { job, parentPid, pidPath, outcome } = await startJobbedParent(limitFlags, CHILD_SCRIPT);
	try {
		expect(outcome).toMatchObject({ ok: true, value: { exited: false } });
		const childPid = Number(readFileSync(pidPath, "utf8"));
		spawnedPids.add(childPid);
		// The child gets the caller's environment, cleaned of the secret-bearing names (also through the broker).
		const names: string[] = JSON.parse(readFileSync(`${pidPath}.env`, "utf8"));
		expect(names).toContain("RIG_KEEP_ME");
		expect(names.filter((name) => /^(CLAUDE|TELEGRAM_HUB_|ANTHROPIC_)/i.test(name))).toEqual([]);
		expect(isAlive(childPid)).toBe(true);
		const childHandle = kernel.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, childPid);
		expect(childHandle).not.toBe(0n);
		const inJob = new Int32Array(1);
		expect(kernel.symbols.IsProcessInJob(childHandle, job, ptr(inJob))).toBe(1);
		kernel.symbols.CloseHandle(childHandle);
		expect(inJob[0]).toBe(0);
		expect(kernel.symbols.TerminateJobObject(job, TERMINATED_EXIT_CODE)).toBe(1);
		expect(await waitFor(() => !isAlive(parentPid), GONE_BOUND_MS)).toBe(true);
		await sleep(SURVIVAL_WINDOW_MS);
		expect(isAlive(childPid)).toBe(true);
	} finally {
		kernel.symbols.CloseHandle(job);
	}
};

describe.skipIf(!ON_WINDOWS)("spawnDetached on Windows leaves the caller's job", () => {
	test("a caller whose job forbids breakaway (a Scheduled Task's job)", async () => {
		await runEscapeCheck(JOB_LIMIT_NONE);
	}, TEST_BOUND_MS);

	test("a caller whose job allows breakaway", async () => {
		await runEscapeCheck(JOB_LIMIT_BREAKAWAY_OK);
	}, TEST_BOUND_MS);

	test("a command that fails at once reports its exit code and stderr, through the broker too", async () => {
		await runFailCheck(JOB_LIMIT_NONE);
		await runFailCheck(JOB_LIMIT_BREAKAWAY_OK);
	}, TEST_BOUND_MS);
});
