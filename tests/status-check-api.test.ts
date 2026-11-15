import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

// `rig status` and `rig check` under the API output contract: one JSON object on stdout, raw data only.

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const RULE_BLOCK = "<!-- rig:begin -->\n<!-- rig:end -->\n";
const SINGLE_LINE = 1;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
// The keys the hub validates strictly in `status --json` (plugin/src/hub/rig.ts, statusSchema).
const STATUS_KEYS = ["schemaVersion", "mode", "versions", "releases", "features", "lastUpdate", "pendingHubRestart", "errors"];

const seedInstalled = (): ReturnType<typeof createMemoryRuntime> => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo"));
	const state = { mode: "dev", paths: { repo: REPO, hub: HUB }, features: { demo: false }, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	harness.fs.seed(`${HOME}/.codex/AGENTS.md`, RULE_BLOCK);
	harness.fs.seed(`${HOME}/.agent-rig/generated/CLAUDE.md`, "");
	harness.fs.seed(`${HOME}/.claude/CLAUDE.md`, "@../.codex/AGENTS.md\n@../.agent-rig/generated/CLAUDE.md\n");
	harness.fs.seed(`${HOME}/.claude/settings.json`, "{}\n");
	return harness;
};

const run = async (harness: ReturnType<typeof createMemoryRuntime>, args: string[]): Promise<{ code: number; output: string[] }> => {
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), harness.runtime);
	return { code, output };
};

describe("rig status as JSON", () => {
	test("prints the one StatusView object the hub parses, with `--json` ignored", async () => {
		const plain = await run(seedInstalled(), ["status"]);
		const flagged = await run(seedInstalled(), ["status", "--json"]);
		expect(plain.code).toBe(SUCCESS_EXIT_CODE);
		expect(plain.output).toHaveLength(SINGLE_LINE);
		expect(plain.output).toEqual(flagged.output);
		const value: unknown = JSON.parse(plain.output[0]);
		expect(value).toMatchObject({ schemaVersion: 1, mode: "dev", pendingHubRestart: null, errors: [], lastUpdate: null });
		expect(Object.keys(typeof value === "object" && value !== null ? value : {})).toEqual(STATUS_KEYS);
	});

	test("an unreadable state is a state-unreadable failure", async () => {
		const result = await run(createMemoryRuntime(), ["status"]);
		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(result.output).toHaveLength(SINGLE_LINE);
		expect(JSON.parse(result.output[0])).toMatchObject({ error: { code: "state-unreadable" } });
	});
});

describe("rig check as JSON", () => {
	test("a passing check prints {checked:true}", async () => {
		const result = await run(seedInstalled(), ["check"]);
		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.output).toEqual(["{\"checked\":true}"]);
	});

	test("a defect is a check-failed failure whose message lists the problem", async () => {
		const harness = seedInstalled();
		harness.fs.seed(`${HOME}/.codex/AGENTS.md`, "no block\n");
		const result = await run(harness, ["check"]);
		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(result.output).toHaveLength(SINGLE_LINE);
		const value: unknown = JSON.parse(result.output[0]);
		expect(value).toMatchObject({ error: { code: "check-failed" } });
		expect(JSON.stringify(value)).toContain(".codex/AGENTS.md");
	});

	test("an unreadable state is a check-unreadable failure", async () => {
		const result = await run(createMemoryRuntime(), ["check"]);
		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(JSON.parse(result.output[0])).toMatchObject({ error: { code: "check-unreadable" } });
	});
});
