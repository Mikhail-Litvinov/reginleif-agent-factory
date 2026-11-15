import type { ProcessPorts } from "../src/ports.js";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem, createRealRuntime } from "../src/commands/real-runtime.js";
import { messagesFor } from "../src/messages";

const TEST_MESSAGES = messagesFor("en");

// The real process and file ports, run against tiny real processes (the other tests only see fakes).

// A sleeping child must outlive every check; the tests kill it long before this timer fires.
const CHILD_LIFETIME_MS = 60_000;
// Polling step for "the process appeared / is gone"; short so the file stays fast.
const POLL_STEP_MS = 20;
// Upper bound for a child script to start and write its pid file (bun start-up is well under a second).
const START_BOUND_MS = 10_000;
// Upper bound for the OS to finish removing a killed process.
const GONE_BOUND_MS = 5_000;
// Launch grace for the sleeping command: the child must still be alive when it ends.
const SURVIVE_GRACE_MS = 500;
// Launch grace for the failing command: it exits at once, so the grace is only a bound, never waited fully.
const FAIL_GRACE_MS = 10_000;
const STDERR_LIMIT = 1000;
const TEST_BOUND_MS = 30_000;
const FAILING_EXIT_CODE = 3;
const STDERR_MARKER = "rig-test-stderr-marker";

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitFor = async (condition: () => boolean, boundMs: number): Promise<boolean> => {
	const deadline = Date.now() + boundMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(POLL_STEP_MS);
	}
	return condition();
};

let ports: ProcessPorts;
let directory = "";
const spawnedPids = new Set<number>();

beforeAll(async () => {
	const runtime = await createRealRuntime();
	if (!runtime.ok) throw new Error(runtime.error);
	ports = runtime.value.process;
});

afterEach(() => {
	for (const pid of spawnedPids) {
		try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
	}
	spawnedPids.clear();
	if (directory !== "") rmSync(directory, { recursive: true, force: true });
	directory = "";
});

const makeDirectory = (): string => {
	directory = mkdtempSync(join(tmpdir(), "rig-real-ports-"));
	return directory;
};

const SLEEPER_SCRIPT = `setTimeout(() => {}, ${CHILD_LIFETIME_MS});\n`;
const PARENT_SCRIPT = [
	"const { spawn } = require(\"node:child_process\");",
	"const { writeFileSync } = require(\"node:fs\");",
	"const grandchild = spawn(process.execPath, [process.argv[2]], { stdio: \"ignore\" });",
	"writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));",
	`setTimeout(() => {}, ${CHILD_LIFETIME_MS});`,
	"",
].join("\n");

// Starts a bun child (which starts a bun grandchild) and returns both pids once the child has written them.
const startTree = async (): Promise<{ parent: number; grandchild: number }> => {
	const root = makeDirectory();
	const sleeperPath = join(root, "sleeper.js");
	const parentPath = join(root, "parent.js");
	const pidsPath = join(root, "pids.json");
	writeFileSync(sleeperPath, SLEEPER_SCRIPT);
	writeFileSync(parentPath, PARENT_SCRIPT);
	const child = spawn(process.execPath, [parentPath, sleeperPath, pidsPath], { stdio: "ignore" });
	child.unref();
	if (child.pid !== undefined) spawnedPids.add(child.pid);
	const written = await waitFor(() => {
		try { return readFileSync(pidsPath, "utf8").length > 0; } catch { return false; }
	}, START_BOUND_MS);
	if (!written) throw new Error("The child did not write its pid file");
	const parsed: unknown = JSON.parse(readFileSync(pidsPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || !("parent" in parsed) || !("grandchild" in parsed)) throw new Error("Bad pid file");
	if (typeof parsed.parent !== "number" || typeof parsed.grandchild !== "number") throw new Error("Bad pid file");
	spawnedPids.add(parsed.grandchild);
	return { parent: parsed.parent, grandchild: parsed.grandchild };
};

describe("real process ports", () => {
	test("createdAt gives a time for a live pid and null for a dead one", async () => {
		const tree = await startTree();
		const live = await ports.createdAt([tree.parent]);
		expect(live.ok).toBe(true);
		if (!live.ok) return;
		const time = live.value[String(tree.parent)];
		expect(typeof time).toBe("string");
		expect(Number.isNaN(Date.parse(String(time)))).toBe(false);
		await ports.killTree(tree.parent);
		expect(await waitFor(() => !isAlive(tree.parent), GONE_BOUND_MS)).toBe(true);
		const dead = await ports.createdAt([tree.parent]);
		expect(dead.ok).toBe(true);
		if (dead.ok) expect(dead.value[String(tree.parent)]).toBeNull();
	}, TEST_BOUND_MS);

	test("killTree kills the process and its grandchild", async () => {
		const tree = await startTree();
		expect(isAlive(tree.parent)).toBe(true);
		expect(isAlive(tree.grandchild)).toBe(true);
		const killed = await ports.killTree(tree.parent);
		expect(killed).toEqual({ ok: true, value: undefined });
		expect(await waitFor(() => !isAlive(tree.parent), GONE_BOUND_MS)).toBe(true);
		expect(await waitFor(() => !isAlive(tree.grandchild), GONE_BOUND_MS)).toBe(true);
	}, TEST_BOUND_MS);

	test("spawnDetached reports a fast-failing command as exited with its stderr", async () => {
		const root = makeDirectory();
		const scriptPath = join(root, "fail.js");
		writeFileSync(scriptPath, `process.stderr.write("${STDERR_MARKER}"); process.exit(${FAILING_EXIT_CODE});\n`);
		const result = await ports.spawnDetached([process.execPath, scriptPath], FAIL_GRACE_MS, STDERR_LIMIT, join(root, "stderr.log"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exited).toBe(true);
		expect(result.value.exitCode).toBe(FAILING_EXIT_CODE);
		expect(result.value.stderr).toContain(STDERR_MARKER);
	}, TEST_BOUND_MS);

	test("spawnDetached starts the command without the secret-bearing variables", async () => {
		const root = makeDirectory();
		const scriptPath = join(root, "env.js");
		const outPath = join(root, "env.json");
		writeFileSync(scriptPath, `require("node:fs").writeFileSync(process.argv[2], JSON.stringify(Object.keys(process.env)));\n`);
		const names = ["CLAUDE_CONFIG_DIR", "TELEGRAM_HUB_BOT_TOKEN", "ANTHROPIC_API_KEY", "RIG_KEEP_ME"];
		const saved = names.map((name) => process.env[name]);
		for (const name of names) process.env[name] = "x";
		try {
			const result = await ports.spawnDetached([process.execPath, scriptPath, outPath], FAIL_GRACE_MS, STDERR_LIMIT, join(root, "stderr.log"));
			expect(result.ok && result.value.exitCode).toBe(0);
		} finally {
			names.forEach((name, index) => { const value = saved[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
		}
		const seen: string[] = JSON.parse(readFileSync(outPath, "utf8"));
		expect(seen).toContain("RIG_KEEP_ME");
		expect(seen.filter((name) => /^(CLAUDE|TELEGRAM_HUB_|ANTHROPIC_)/i.test(name))).toEqual([]);
	}, TEST_BOUND_MS);

	test("spawnDetached reports a surviving command as started", async () => {
		const root = makeDirectory();
		const scriptPath = join(root, "sleep.js");
		const pidPath = join(root, "pid.txt");
		writeFileSync(scriptPath, `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, ${CHILD_LIFETIME_MS});\n`);
		const result = await ports.spawnDetached([process.execPath, scriptPath, pidPath], SURVIVE_GRACE_MS, STDERR_LIMIT, join(root, "stderr.log"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exited).toBe(false);
		expect(result.value.exitCode).toBeNull();
		const pid = Number(readFileSync(pidPath, "utf8"));
		spawnedPids.add(pid);
		expect(isAlive(pid)).toBe(true);
		const killed = await ports.killTree(pid);
		expect(killed.ok).toBe(true);
		expect(await waitFor(() => !isAlive(pid), GONE_BOUND_MS)).toBe(true);
	}, TEST_BOUND_MS);

	test("appendBytes appends exactly the given bytes", async () => {
		const root = makeDirectory();
		const path = join(root, "log.bin");
		const files = createFileSystem(TEST_MESSAGES);
		await files.appendBytes(path, new Uint8Array([0, 1, 255]));
		await files.appendBytes(path, new Uint8Array([10, 13]));
		expect([...readFileSync(path)]).toEqual([0, 1, 255, 10, 13]);
	}, TEST_BOUND_MS);

	test("writeBytes replaces an existing file with exactly the given bytes", async () => {
		const root = makeDirectory();
		const path = join(root, "command.bin");
		const files = createFileSystem(TEST_MESSAGES);
		await files.writeBytes(path, new Uint8Array([0, 1, 255]));
		await files.writeBytes(path, new Uint8Array([10, 13]));
		expect([...readFileSync(path)]).toEqual([10, 13]);
	}, TEST_BOUND_MS);
});
