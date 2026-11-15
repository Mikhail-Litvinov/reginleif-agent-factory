import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { commandNames, parseCommand, runCli } from "../src/cli.js";
import { ERROR_CODE_USAGE, renderFailure, renderProgress, renderSuccess } from "../src/output.js";
import { readStoredLanguage } from "../src/state.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

// The guard of the API output contract (docs/superpowers/specs/agent-rig-design.md, "API output"): every command prints
// one JSON object on stdout and nothing else, on success and on failure. The commands are enumerated from the
// dispatcher (`commandNames`), never from a hand list here, so a new command without a fixture fails this file.

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SESSIONS = `${HOME}/.agent-rig/sessions`;
const SESSION_ID = "11111111-aaaa";
const SUCCESS_EXIT_CODE = 0;
const SINGLE_LINE = 1;
const RULE_BLOCK = "<!-- rig:begin -->\n<!-- rig:end -->\n";

type Run = { code: number; output: string[] };
type Seeding = "none" | "installed";
type Fixture = {
	// Args that run to success on an `installed` harness.
	success: string[];
	// Args that parse to this command and fail while it runs, on the harness named by `failureSeeding`.
	failure: string[] | null;
	failureSeeding: Seeding;
	// Args that fail in the parser.
	usage: string[];
};

const FIXTURES: Record<string, Fixture> = {
	"help": { success: ["help"], failure: null, failureSeeding: "none", usage: ["help", "extra"] },
	"install": { success: ["install", "--dev"], failure: ["install", "--dev"], failureSeeding: "none", usage: ["install", "--bogus"] },
	"apply": { success: ["apply"], failure: ["apply"], failureSeeding: "none", usage: ["apply", "extra"] },
	"feature-list": { success: ["feature"], failure: ["feature"], failureSeeding: "none", usage: ["feature", "demo"] },
	"feature-change": { success: ["feature", "demo", "enable"], failure: ["feature", "missing", "enable"], failureSeeding: "installed", usage: ["feature", "demo", "toggle"] },
	"update": { success: ["update", "--pending"], failure: ["update"], failureSeeding: "installed", usage: ["update", "--later"] },
	"status": { success: ["status"], failure: ["status"], failureSeeding: "none", usage: ["status", "--yaml"] },
	"check": { success: ["check"], failure: ["check"], failureSeeding: "none", usage: ["check", "extra"] },
	"language": { success: ["language"], failure: ["language", "en"], failureSeeding: "none", usage: ["language", "fr"] },
	"info": { success: ["info", "--session", SESSION_ID], failure: ["info", "--session", "missing-session"], failureSeeding: "installed", usage: ["info"] },
	"session": { success: ["session", "list"], failure: null, failureSeeding: "none", usage: ["session", "unknown"] },
	"exec": { success: ["exec", "list"], failure: ["exec", "stop", "../bad"], failureSeeding: "none", usage: ["exec", "unknown"] },
	"exec-runner": { success: ["exec-runner", "test"], failure: ["exec-runner", "missing"], failureSeeding: "none", usage: ["exec-runner"] },
	"update-step": { success: ["update-step", "apply", "10", "20"], failure: ["update-step", "apply", "10", "20"], failureSeeding: "installed", usage: ["update-step", "rollback", "10", "20"] },
};

// Commands that still print text on success. A migration step removes a command from this list in the same change that
// moves it to a typed result; the test below fails for a listed command that already prints JSON, so the list cannot rot.
const PENDING_COMMANDS: readonly string[] = [];

// `rig update` runs `update-step` as a child and reads its stdout and exit code as text (runUpdateStepProcess in
// src/commands/update.ts); it is a process-internal protocol, not part of the API.
const INTERNAL_COMMANDS: readonly string[] = ["update-step", "exec-runner"];

// `installed`: state, features, a session and the generated files that `check` reads are seeded.
const seed = (seeding: Seeding): MemoryRuntimeHarness => {
	const harness = createMemoryRuntime();
	if (seeding === "none") return harness;
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo"));
	const state = { mode: "dev", paths: { repo: REPO, hub: HUB }, features: { demo: false }, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	harness.fs.seed(`${SESSIONS}/${SESSION_ID}.json`, JSON.stringify({ session_id: SESSION_ID, config_dir: "/cfg/1-own", cwd: null, transcript_path: null, pid: null, pid_created: null, started_at: "2026-01-01T00:00:00Z", ended_at: null }));
	harness.fs.seed(`${HOME}/.codex/AGENTS.md`, RULE_BLOCK);
	harness.fs.seed(`${HOME}/.agent-rig/generated/CLAUDE.md`, "");
	harness.fs.seed(`${HOME}/.claude/CLAUDE.md`, "@../.codex/AGENTS.md\n@../.agent-rig/generated/CLAUDE.md\n");
	harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");
	return harness;
};

const run = async (harness: MemoryRuntimeHarness, args: string[]): Promise<Run> => {
	const output: string[] = [];
	harness.runtime.language = await readStoredLanguage(harness.fs, HOME);
	const code = await runCli(args, (line) => output.push(line), harness.runtime);
	return { code, output };
};

const parsesAsJsonObject = (output: string[]): boolean => {
	if (output.length !== SINGLE_LINE) return false;
	try {
		const value: unknown = JSON.parse(output[0]);
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
};

const isErrorObject = (output: string[]): boolean => {
	if (!parsesAsJsonObject(output)) return false;
	const value: unknown = JSON.parse(output[0]);
	if (typeof value !== "object" || value === null || !("error" in value) || Object.keys(value).length !== SINGLE_LINE) return false;
	const { error } = value;
	return typeof error === "object" && error !== null && "code" in error && "message" in error
		&& typeof error.code === "string" && error.code !== "" && typeof error.message === "string";
};

const names = (): string[] => [...commandNames];
const jsonCommands = (): string[] => names().filter((name) => !PENDING_COMMANDS.includes(name) && !INTERNAL_COMMANDS.includes(name));

describe("API output guard", () => {
	test("every command of the dispatcher has fixtures, and each fixture parses to its command", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual(names().sort());
		for (const name of names()) {
			const fixture = FIXTURES[name];
			for (const args of fixture.failure === null ? [fixture.success] : [fixture.success, fixture.failure]) {
				const parsed = parseCommand(args);
				expect(parsed.ok ? String(parsed.command.name) : null).toBe(name);
			}
			expect(parseCommand(fixture.usage).ok).toBe(false);
		}
	});

	test("the pending and internal lists name real commands and do not overlap", () => {
		for (const name of [...PENDING_COMMANDS, ...INTERNAL_COMMANDS]) expect(names()).toContain(name);
		expect(PENDING_COMMANDS.filter((name) => INTERNAL_COMMANDS.includes(name))).toEqual([]);
	});

	test("a migrated command prints exactly one JSON object on success and exits 0", async () => {
		for (const name of jsonCommands()) {
			const result = await run(seed("installed"), FIXTURES[name].success);
			expect({ name, code: result.code }).toEqual({ name, code: SUCCESS_EXIT_CODE });
			expect({ name, json: parsesAsJsonObject(result.output), error: isErrorObject(result.output) }).toEqual({ name, json: true, error: false });
		}
	});

	test("a command in the pending list still prints text on success (the list shrinks as commands migrate)", async () => {
		for (const name of PENDING_COMMANDS) {
			const result = await run(seed("installed"), FIXTURES[name].success);
			expect({ name, code: result.code }).toEqual({ name, code: SUCCESS_EXIT_CODE });
			expect({ name, json: parsesAsJsonObject(result.output) }).toEqual({ name, json: false });
		}
	});

	test("every command except the internal one prints the JSON error object and exits nonzero when it fails while running", async () => {
		for (const name of names().filter((command) => !INTERNAL_COMMANDS.includes(command))) {
			const fixture = FIXTURES[name];
			// `help` has no failure while running; its failure is the usage error below.
			if (fixture.failure === null) continue;
			const result = await run(seed(fixture.failureSeeding), fixture.failure);
			expect({ name, failed: result.code !== SUCCESS_EXIT_CODE, error: isErrorObject(result.output) }).toEqual({ name, failed: true, error: true });
		}
	});

	test("every command except the internal one prints the JSON usage error for malformed arguments", async () => {
		for (const name of names().filter((command) => !INTERNAL_COMMANDS.includes(command))) {
			const result = await run(seed("installed"), FIXTURES[name].usage);
			expect({ name, failed: result.code !== SUCCESS_EXIT_CODE, error: isErrorObject(result.output) }).toEqual({ name, failed: true, error: true });
			expect(JSON.parse(result.output[0])).toMatchObject({ error: { code: ERROR_CODE_USAGE } });
		}
	});

	test("the internal command keeps its text failure for the parent process", async () => {
		for (const name of INTERNAL_COMMANDS) {
			const fixture = FIXTURES[name];
			if (fixture.failure === null) throw new Error(`internal command ${name} needs a failure fixture`);
			const result = await run(seed(fixture.failureSeeding), fixture.failure);
			expect({ name, failed: result.code !== SUCCESS_EXIT_CODE, json: parsesAsJsonObject(result.output) }).toEqual({ name, failed: true, json: false });
		}
	});

	test("a runtime that cannot be built is reported as a JSON error too", async () => {
		const output: string[] = [];
		const code = await runCli(["status"], (line) => output.push(line), undefined, {
			readLanguage: async () => "en",
			create: async () => ({ ok: false, error: "no home directory" }),
		});
		expect(code).not.toBe(SUCCESS_EXIT_CODE);
		expect(output).toEqual([renderFailure({ code: "runtime-unavailable", message: "no home directory" })]);
	});

	test("the renderers print single-line JSON; progress is `{progress}` and never reaches stdout", async () => {
		expect(renderSuccess({ a: 1 })).toBe("{\"a\":1}");
		expect(renderFailure({ code: "x", message: "y" })).toBe("{\"error\":{\"code\":\"x\",\"message\":\"y\"}}");
		expect(renderProgress({ code: "step", data: { n: 1 } })).toBe("{\"progress\":{\"code\":\"step\",\"data\":{\"n\":1}}}");
		const events: unknown[] = [];
		const output: string[] = [];
		await runCli(["help"], (line) => output.push(line), seed("installed").runtime, undefined, (event) => events.push(event));
		expect(output).toHaveLength(SINGLE_LINE);
		expect(events).toEqual([]);
	});

	test("`--json` is still accepted by the commands that took it, and ignored by the output contract", () => {
		expect(parseCommand(["status", "--json"]).ok).toBe(true);
		expect(parseCommand(["feature", "--json"]).ok).toBe(true);
		expect(parseCommand(["language", "--json"]).ok).toBe(true);
	});

	test("session compact, rename and autocompact follow the JSON API contract", async () => {
		for (const [args, result] of [
			[["session", "compact", SESSION_ID], { tokensBefore: 90, tokensAfter: 30 }],
			[["session", "compact", SESSION_ID], { skip: "hook veto" }],
			[["session", "rename", SESSION_ID, "new title"], { name: "new title" }],
			[["session", "autocompact", SESSION_ID, "200000"], { window: 200000, text: "Window set" }],
			[["session", "autocompact", SESSION_ID, "auto"], { window: "auto" }],
		] as const) {
			const harness = seed("installed");
			harness.fs.seed(`${SESSIONS}/${SESSION_ID}.json`, JSON.stringify({ session_id: SESSION_ID, cwd: null, transcript_path: null, pid: 42, pid_created: "2026-01-01T00:00:00.000000Z", started_at: "2026-01-01T00:00:00Z", ended_at: null }));
			harness.fs.directories.add(`${SESSIONS}/${SESSION_ID}`);
			harness.fs.seed(`${SESSIONS}/${SESSION_ID}/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result }));
			harness.runtime.process.createdAt = async () => ({ ok: true, value: { "42": "2026-01-01T00:00:00.000000Z" } });
			const output: string[] = [];
			const code = await runCli([...args], (line) => output.push(line), harness.runtime);
			expect(code).toBe(SUCCESS_EXIT_CODE);
			expect(output).toHaveLength(SINGLE_LINE);
			expect(JSON.parse(output[0])).toEqual({ session: SESSION_ID, ...result });
		}
		const output: string[] = [];
		const code = await runCli(["session", "rename", SESSION_ID, "  "], (line) => output.push(line), seed("installed").runtime);
		expect(code).toBe(1);
		expect(output).toHaveLength(SINGLE_LINE);
		expect(isErrorObject(output)).toBe(true);
	});
});
