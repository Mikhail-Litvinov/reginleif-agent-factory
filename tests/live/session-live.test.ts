import type { ChildProcess } from "node:child_process";

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// Live probe of `rig session list`, `rename`, `compact` and `cleanup` against a real headless Claude Code session.
// It starts a headless session and calls a model (haiku), which costs money, so it runs only when RIG_LIVE is "1".
// What it proves: the session is found by lookup (`session list`), it is live with its window module loaded (the queue),
// `rename` writes the name, and a refused compaction stops `cleanup` with nothing touched: the process stays alive,
// the transcript stays byte-identical and no `.cleanup-*` backup is written.
// What it does not prove: the compact and cleanup success paths. Those need an interactive session, where the engine
// compacts inside a turn. The user chose to verify them on the first real /cleanup after the hub moves to `rig session`.
// If a future Claude Code supports headless compaction, the refusal assertions fail: the test must then be rewritten
// for the success path, not patched to accept both outcomes.
const LIVE_ENV_VARIABLE = "RIG_LIVE";
const LIVE_ENV_VALUE = "1";

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const CLI_PATH = join(REPOSITORY_ROOT, "src", "cli.ts");
const SESSIONS_DIR_PARTS = [".agent-rig", "sessions"];
const PROBE_NAME = "rig-live-probe";
const MODEL = "haiku";
const FIRST_PROMPT = "Answer in exactly two short sentences: what is a hash map?";
const SECOND_PROMPT = "Answer in exactly two short sentences: what is a linked list?";
const BACKUP_PATTERN = /\.cleanup-\d+\.jsonl$/;
// Observed on Claude Code 2.1.325: a headless (-p) session refuses a compact request with this module error,
// because the engine compacts only inside an interactive turn. The test asserts this refusal.
const MODULE_ERROR_CODE = "session-module-error";
const HEADLESS_COMPACT_TEXT = "not available in a headless";

// Poll step for every "until the condition holds" wait; short, the bounds below are what limits the waits.
const POLL_STEP_MS = 250;
// A haiku turn of two sentences ends well within this bound (the first one also loads the engine and its modules).
const TURN_BOUND_MS = 120_000;
// The module registers on session.start and the hook writes the record at the same time; both are quick after init.
const MODULE_BOUND_MS = 30_000;
// The CLI waits up to ten minutes for a compaction (COMPACT_TIMEOUT_MS).
const CLI_BOUND_MS = 12 * 60_000;
const TURN_COUNT = 2;
// Compact and cleanup are the two calls that wait for the window (rename waits the same bound but answers within a poll).
const SLOW_CLI_CALLS = 2;
// A whole scenario: two turns, the module appearing, the two slow CLI calls.
const TEST_BOUND_MS = TURN_COUNT * TURN_BOUND_MS + MODULE_BOUND_MS + SLOW_CLI_CALLS * CLI_BOUND_MS;
const STDERR_TAIL_CHARS = 2000;
// A just-killed process may still hold a file for a moment on Windows; rmSync retries this many times, one poll step apart.
const REMOVE_RETRIES = 20;

type Json = Record<string, unknown>;
type CliOutcome = { code: number | null; value: Json | null; stdout: string; stderr: string };

const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (describeWait: string, condition: () => boolean | Promise<boolean>, boundMs: number): Promise<void> => {
	const deadline = Date.now() + boundMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out after ${boundMs} ms waiting for ${describeWait}`);
		await sleep(POLL_STEP_MS);
	}
};

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Kills a process and its children by PID, never by image name (other sessions run the same image).
const killTree = (pid: number): void => {
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
	else {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
};

const rig = (args: string[]): Promise<CliOutcome> =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", reject);
		child.on("close", (code) => {
			const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
			let value: Json | null = null;
			try {
				const parsed: unknown = JSON.parse(lines.at(-1) ?? "");
				value = object(parsed) ? parsed : null;
			} catch {
				value = null;
			}
			resolve({ code, value, stdout, stderr: stderr.slice(-STDERR_TAIL_CHARS) });
		});
	});

// A headless session kept alive by an open stdin: stream-json in, stream-json out.
type Headless = { child: ChildProcess; events: Json[]; stderr: () => string; send: (text: string) => void };

const startHeadless = (cwd: string): Headless => {
	const env = { ...process.env };
	delete env.CLAUDE_PID;
	const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", MODEL], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const events: Json[] = [];
	let pending = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			try {
				const parsed: unknown = JSON.parse(line);
				if (object(parsed)) events.push(parsed);
			} catch {
				// A non-JSON line is not an event.
			}
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
	const send = (text: string): void => {
		child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
	};
	return { child, events, stderr: () => stderr.slice(-STDERR_TAIL_CHARS), send };
};

const resultCount = (headless: Headless): number => headless.events.filter((event) => event.type === "result").length;

const sessionIdOf = (headless: Headless): string | null => {
	for (const event of headless.events) if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") return event.session_id;
	return null;
};

const listEntry = (outcome: CliOutcome, id: string): Json | null => {
	const sessions = outcome.value?.sessions;
	if (!Array.isArray(sessions)) return null;
	for (const entry of sessions) if (object(entry) && entry.id === id) return entry;
	return null;
};

const live = process.env[LIVE_ENV_VARIABLE] === LIVE_ENV_VALUE;

describe.skipIf(!live)("live rig session commands (calls a model, RIG_LIVE=1)", () => {
	test(
		"rename, compact and cleanup against a real headless session",
		async () => {
			const killTasks: Array<() => void> = [];
			const removeTasks: Array<() => void> = [];
			const cwd = mkdtempSync(join(tmpdir(), "rig-live-"));
			removeTasks.push(() => rmSync(cwd, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: POLL_STEP_MS }));
			const headless = startHeadless(cwd);
			killTasks.push(() => {
				if (headless.child.pid !== undefined) killTree(headless.child.pid);
			});
			let recordedPid: number | null = null;
			killTasks.push(() => {
				if (recordedPid !== null) killTree(recordedPid);
			});
			try {
				// Step 1: one turn, and the session stays idle (stdin open).
				headless.send(FIRST_PROMPT);
				await waitFor("the first result event", () => resultCount(headless) >= 1 || headless.child.exitCode !== null, TURN_BOUND_MS);
				expect(headless.child.exitCode, `the session exited early: ${headless.stderr()}`).toBeNull();
				const id = sessionIdOf(headless);
				expect(id).not.toBeNull();
				if (id === null) return;

				// Step 2: the session is listed live with its window module loaded.
				let entry: Json | null = null;
				await waitFor("the session listed live with the module", async () => {
					entry = listEntry(await rig(["session", "list"]), id);
					return entry !== null && entry.live === true && entry.module === true;
				}, MODULE_BOUND_MS);
				expect(entry).not.toBeNull();
				if (entry === null) return;
				const listed: Json = entry;
				if (typeof listed.pid === "number") recordedPid = listed.pid;
				const transcriptPath = listed.transcriptPath;
				expect(typeof transcriptPath).toBe("string");
				if (typeof transcriptPath !== "string") return;
				expect(typeof listed.pid).toBe("number");
				// The records this session leaves in the user's home and config dir belong to this run only: remove them at the end.
				const sessionsDir = join(homedir(), ...SESSIONS_DIR_PARTS);
				const transcriptDir = dirname(transcriptPath);
				removeTasks.push(() => {
					rmSync(join(sessionsDir, `${id}.json`), { force: true });
					rmSync(join(sessionsDir, id), { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: POLL_STEP_MS });
					if (basename(transcriptDir).endsWith(basename(cwd))) rmSync(transcriptDir, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: POLL_STEP_MS });
				});

				// Step 3: rename answers with the name.
				const renamed = await rig(["session", "rename", id, PROBE_NAME]);
				console.log("rename", renamed.stdout.trim());
				expect(renamed.value).toEqual({ session: id, name: PROBE_NAME });

				// Step 4: a headless session cannot be compacted: the engine refuses with the module error.
				const compacted = await rig(["session", "compact", id]);
				console.log("compact", compacted.stdout.trim());
				expect(compacted.value?.error).toMatchObject({ code: MODULE_ERROR_CODE, message: expect.stringContaining(HEADLESS_COMPACT_TEXT) });

				// Step 5: one more turn, then cleanup is refused: it stops nothing and touches nothing.
				const resultsBefore = resultCount(headless);
				headless.send(SECOND_PROMPT);
				await waitFor("the second result event", () => resultCount(headless) > resultsBefore || headless.child.exitCode !== null, TURN_BOUND_MS);
				expect(headless.child.exitCode, `the session exited early: ${headless.stderr()}`).toBeNull();
				const transcriptBefore = readFileSync(transcriptPath);
				const cleaned = await rig(["session", "cleanup", id]);
				console.log("cleanup", cleaned.stdout.trim(), cleaned.stderr.trim());
				expect(cleaned.value?.error).toMatchObject({ code: MODULE_ERROR_CODE, message: expect.stringContaining(HEADLESS_COMPACT_TEXT) });
				expect(isAlive(headless.child.pid ?? 0)).toBe(true);
				expect(recordedPid !== null && isAlive(recordedPid)).toBe(true);
				expect(readFileSync(transcriptPath)).toEqual(transcriptBefore);
				expect(readdirSync(dirname(transcriptPath)).filter((name) => name.startsWith(id) && BACKUP_PATTERN.test(name))).toEqual([]);
			} finally {
				// Processes first (they hold the transcript open on Windows), then the files.
				for (const task of [...killTasks, ...removeTasks]) {
					try {
						task();
					} catch {
						// Cleanup keeps going: the other tasks still have to run.
					}
				}
			}
		},
		TEST_BOUND_MS,
	);
});
