import type { ProgressEvent } from "../src/output.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature, seedRigPluginManifest } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const NEW_PLUGIN = "sample@sample-market";
const UPDATED_PLUGIN = "old@claude-plugins-official";
const PLUGIN_PROGRESS_CODE = "plugin-command";
const SUCCESS_EXIT_CODE = 0;
const INSTALLED_PLUGIN_VERSION = "1";
const SOURCE_PLUGIN_VERSION = "2";

const setup = (enabled: boolean): MemoryRuntimeHarness => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo", { plugins: ["rig:sample", UPDATED_PLUGIN] }));
	seedRigPluginManifest(harness.fs, REPO, "sample", "sample-market");
	harness.installedPlugins.add(UPDATED_PLUGIN);
	harness.runtime.process.run = async (command, args, options) => {
		harness.processCalls.push({ command, args, options });
		if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
			return { ok: true, value: { stdout: JSON.stringify([{ name: "claude-plugins-official" }]), stderr: "", exitCode: SUCCESS_EXIT_CODE } };
		}
		if (command === "claude" && args.join(" ") === "plugin list --json") {
			return { ok: true, value: { stdout: JSON.stringify([{ id: UPDATED_PLUGIN, version: INSTALLED_PLUGIN_VERSION, folderVersion: SOURCE_PLUGIN_VERSION }]), stderr: "", exitCode: SUCCESS_EXIT_CODE } };
		}
		if (command === "claude" && args[0] === "plugin" && args[1] === "install" && args[2] !== undefined) harness.installedPlugins.add(args[2]);
		return { ok: true, value: { stdout: "", stderr: "", exitCode: SUCCESS_EXIT_CODE } };
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify({ mode: "dev", paths: { repo: REPO, hub: HUB }, features: { demo: enabled }, records: {}, badPairs: [], pendingHubRestart: null })}\n`);
	return harness;
};

const run = async (harness: MemoryRuntimeHarness, cliArgs: readonly string[]) => {
	const args = [...cliArgs];
	const progress: ProgressEvent[] = [];
	const order: string[] = [];
	const originalRun = harness.runtime.process.run;
	harness.runtime.process.run = async (command, processArgs, options) => {
		if (command === "claude" && processArgs[1] !== "list" && !(processArgs[1] === "marketplace" && processArgs[2] === "list")) {
			order.push(`run:${processArgs.slice(1).join(" ")}`);
		}
		return originalRun(command, processArgs, options);
	};
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), harness.runtime, undefined, (event) => {
		progress.push(event);
		order.push(`progress:${event.code}`);
	});
	return { code, output, progress, order };
};

describe("plugin progress", () => {
	test.each([
		{ name: "apply", args: ["apply"], enabled: true },
		{ name: "feature change", args: ["feature", "demo", "enable"], enabled: false },
	])("$name reports each plugin mutation before its command", async ({ args, enabled }) => {
		const harness = setup(enabled);

		const result = await run(harness, args);

		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.progress.map((event) => event.code)).toEqual([PLUGIN_PROGRESS_CODE, PLUGIN_PROGRESS_CODE, PLUGIN_PROGRESS_CODE]);
		expect(result.progress.map((event) => event.data)).toEqual([
			{ program: "claude", args: ["plugin", "marketplace", "add", `${REPO}/plugins/sample`] },
			{ program: "claude", args: ["plugin", "install", NEW_PLUGIN, "--scope", "user", "--yes"] },
			{ program: "claude", args: ["plugin", "update", UPDATED_PLUGIN, "--scope", "user"] },
		]);
		expect(result.order).toEqual([
			"progress:plugin-command",
			"run:marketplace add /repo/plugins/sample",
			"progress:plugin-command",
			`run:install ${NEW_PLUGIN} --scope user --yes`,
			"progress:plugin-command",
			`run:update ${UPDATED_PLUGIN} --scope user`,
		]);
	});

	test("a no-change apply reports no plugin mutations", async () => {
		const harness = setup(true);
		harness.installedPlugins.add(NEW_PLUGIN);
		harness.fs.seed(STATE_PATH, `${JSON.stringify({ mode: "dev", paths: { repo: REPO, hub: HUB }, features: { demo: true }, records: {}, badPairs: [], pendingHubRestart: null })}\n`);
		harness.runtime.process.run = async (command, args, options) => {
			harness.processCalls.push({ command, args, options });
			if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
				return { ok: true, value: { stdout: JSON.stringify([{ name: "claude-plugins-official" }, { name: "sample-market", path: `${REPO}/plugins/sample` }]), stderr: "", exitCode: SUCCESS_EXIT_CODE } };
			}
			if (command === "claude" && args.join(" ") === "plugin list --json") {
				return { ok: true, value: { stdout: JSON.stringify([{ id: NEW_PLUGIN }, { id: UPDATED_PLUGIN, version: SOURCE_PLUGIN_VERSION, folderVersion: SOURCE_PLUGIN_VERSION }]), stderr: "", exitCode: SUCCESS_EXIT_CODE } };
			}
			return { ok: true, value: { stdout: "", stderr: "", exitCode: SUCCESS_EXIT_CODE } };
		};

		const initial = await run(harness, ["apply"]);
		const result = await run(harness, ["apply"]);

		expect(initial.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.progress.filter((event) => event.code === PLUGIN_PROGRESS_CODE)).toEqual([]);
	});
});
