import type { RigState } from "../src/state.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { applyRig } from "../src/apply.js";
import { applyCommand } from "../src/commands/apply.js";
import { runCli } from "../src/cli.js";
import { runExecCommand } from "../src/commands/exec.js";
import { messagesFor } from "../src/messages.js";
import { err } from "../src/result.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

// Each fact in a client message is said once: a port's message names the operation and the path, and a caller adds only
// context the port does not know. The ports are replaced by fakes that fail the way the real ones do: with a catalogue message.

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SETTINGS_PATH = `${HOME}/.claude/settings.json`;
const SOURCE_PATH = `${REPO}/features/demo/assets/folder/note.md`;
const TARGET_PATH = `${HOME}/.claude/notes/note.md`;
const RECORD_PATH = `${HOME}/.agent-rig/exec/event-1/record.json`;
const ONCE = 1;
const NONE = 0;
const messages = messagesFor("en");

const occurrences = (text: string, part: string | RegExp): number => {
	if (typeof part === "string") return text.split(part).length - 1;
	return [...text.matchAll(new RegExp(part.source, `${part.flags.replace("g", "")}g`))].length;
};

const seedState = (harness: MemoryRuntimeHarness, features: Record<string, boolean>): RigState => {
	const state: RigState = { mode: "dev", paths: { repo: REPO, hub: HUB }, features, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	return state;
};

const seedAssetWorld = async (): Promise<MemoryRuntimeHarness> => {
	const harness = createMemoryRuntime();
	harness.fs.seed(SETTINGS_PATH, "{}\n");
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo", { assets: [{ sourcePath: "assets/folder", targetPath: "notes" }] }));
	harness.fs.seed(SOURCE_PATH, "Note");
	const state = seedState(harness, { demo: true });
	const first = await applyRig(harness.runtime, { state, mode: "install" });
	if (!first.ok) throw new Error(first.error);
	return harness;
};

const failReadOf = (harness: MemoryRuntimeHarness, failing: string): void => {
	const original = harness.runtime.assetFs.readFile;
	harness.runtime.assetFs.readFile = async (path) => path === failing ? err(messages.failure.readFailed(path, "disk gone")) : original(path);
};

const applyMessage = async (harness: MemoryRuntimeHarness): Promise<string> => {
	const result = await applyCommand(harness.runtime, () => undefined);
	if (result.ok) throw new Error("apply was expected to fail");
	return result.error.message;
};

const expectSaidOnce = (message: string, path: string): void => {
	expect(occurrences(message, path)).toBe(ONCE);
	expect(occurrences(message, /\bread\b/i)).toBe(ONCE);
	expect(occurrences(message, "disk gone")).toBe(ONCE);
};

describe("a client message says each fact once", () => {
	test("an asset source that cannot be read: the path and the operation once", async () => {
		const harness = await seedAssetWorld();
		harness.fs.files.delete(TARGET_PATH);
		failReadOf(harness, SOURCE_PATH);
		expectSaidOnce(await applyMessage(harness), SOURCE_PATH);
	});

	test("an installed asset that cannot be read: the path and the operation once", async () => {
		const harness = await seedAssetWorld();
		failReadOf(harness, TARGET_PATH);
		expectSaidOnce(await applyMessage(harness), TARGET_PATH);
	});

	test("a process that cannot be started: the operation once", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(STATE_PATH, JSON.stringify({ mode: "dev", paths: { repo: REPO, hub: HUB }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		harness.runtime.process.spawnDetached = async () => err(messages.failure.processSpawnFailed("boom"));
		const result = await runExecCommand(harness.runtime, "start", ["rig", "--", "language"]);
		if (result.ok) throw new Error("start was expected to fail");
		expect(result.error.code).toBe("exec-launch");
		expect(occurrences(result.error.message, "boom")).toBe(ONCE);
		expect(occurrences(result.error.message, /\b(start|launch)/i)).toBe(ONCE);
	});

	test("a run that cannot be stored: the path and the operation once", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(STATE_PATH, JSON.stringify({ mode: "dev", paths: { repo: REPO, hub: HUB }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		const original = harness.fs.writeExclusive.bind(harness.fs);
		harness.fs.writeExclusive = async (path, value) => path === RECORD_PATH ? err(messages.failure.createFailed(path, "disk gone")) : original(path, value);
		const result = await runExecCommand(harness.runtime, "start", ["rig", "--", "language"]);
		if (result.ok) throw new Error("start was expected to fail");
		expect(result.error.code).toBe("exec-io");
		expect(occurrences(result.error.message, RECORD_PATH)).toBe(ONCE);
		expect(occurrences(result.error.message, /\b(create|access)/i)).toBe(ONCE);
		expect(occurrences(result.error.message, "disk gone")).toBe(ONCE);
	});

	test("a settings.json that is not JSON: the operation once", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("demo", { hooks: [{ event: "Stop", matcher: "", command: "echo", shell: "bash" }] }));
		seedState(harness, { demo: true });
		harness.fs.seed(`${HOME}/.codex/AGENTS.md`, "<!-- rig:begin -->\n<!-- rig:end -->\n");
		harness.fs.seed(`${HOME}/.agent-rig/generated/CLAUDE.md`, "");
		harness.fs.seed(`${HOME}/.claude/CLAUDE.md`, "@../.codex/AGENTS.md\n@../.agent-rig/generated/CLAUDE.md\n");
		harness.fs.seed(SETTINGS_PATH, "{ not json");
		const output: string[] = [];
		await runCli(["check"], (line) => output.push(line), harness.runtime);
		const text = output.join("\n");
		expect(occurrences(text, "settings.json")).toBe(ONCE);
		expect(occurrences(text, /\binvalid\b/i)).toBe(ONCE);
		expect(occurrences(text, /\bJSON\b/)).toBe(ONCE);
	});
});


