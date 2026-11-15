import type { ProgressEvent } from "../src/output.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;

const setup = (features: Record<string, boolean>): MemoryRuntimeHarness => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("telegram"));
	seedFeature(harness.fs, REPO, featureManifest("demo"));
	const state = { mode: "dev", paths: { repo: REPO, hub: HUB }, features, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	return harness;
};

const run = async (harness: MemoryRuntimeHarness, args: string[]) => {
	const output: string[] = [];
	const progress: ProgressEvent[] = [];
	const code = await runCli(args, (line) => output.push(line), harness.runtime, undefined, (event) => progress.push(event));
	return { code, output, progress };
};

describe("rig feature as an API", () => {
	test("enabling prints the feature and its new state and reports no progress", async () => {
		const harness = setup({ telegram: false, demo: false });

		const result = await run(harness, ["feature", "demo", "enable"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"feature":"demo","enabled":true}'], progress: [] });
	});

	test("disabling telegram reports that the service is being stopped, as progress", async () => {
		const harness = setup({ telegram: true, demo: false });

		const result = await run(harness, ["feature", "telegram", "disable"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"feature":"telegram","enabled":false}'], progress: [{ code: "service-stopping" }] });
	});

	test("the base feature cannot be switched and has its own code", async () => {
		const harness = setup({ telegram: false, demo: false });

		const result = await run(harness, ["feature", "base", "disable"]);

		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(result.output).toHaveLength(1);
		expect(JSON.parse(result.output[0] ?? "")).toEqual({ error: { code: "base-cannot-toggle", message: "The base feature cannot be switched." } });
		expect(result.progress).toEqual([]);
	});

	test("rig feature without state.json fails with the generic feature failure and writes nothing", async () => {
		const harness = createMemoryRuntime();

		const result = await run(harness, ["feature"]);

		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(JSON.parse(result.output[0] ?? "")).toHaveProperty("error.code", "feature-failed");
		expect(harness.fs.files.has(STATE_PATH)).toBe(false);
	});
});
