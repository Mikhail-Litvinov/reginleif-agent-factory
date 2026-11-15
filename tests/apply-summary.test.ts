import type { PluginChanges } from "../src/apply.js";
import type { ApplyData } from "../src/commands/apply.js";
import type { RigState } from "../src/state.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { applyRig } from "../src/apply.js";
import { applyCommand } from "../src/commands/apply.js";
import { ok } from "../src/result.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature, seedRigPluginManifest } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SETTINGS_PATH = `${HOME}/.claude/settings.json`;
const RIG_PLUGIN = "rig:window-demo";
const RIG_PLUGIN_PATH = `${REPO}/plugins/window-demo`;
const MARKETPLACE = "demo-market";
const STALE_MARKETPLACE = "old-market";
const PROCESS_SUCCESS_EXIT_CODE = 0;
const NO_PLUGIN_CHANGES: PluginChanges = { installed: [], uninstalled: [], marketplacesAdded: [], marketplacesRemoved: [] };
const UP_TO_DATE: ApplyData = { changedFiles: [], pluginChanges: NO_PLUGIN_CHANGES };

type Scenario = {
	harness: MemoryRuntimeHarness;
	run: () => Promise<ApplyData>;
};

const seedDemo = (harness: MemoryRuntimeHarness, plugins: string[]): void => {
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo", { plugins }));
	seedRigPluginManifest(harness.fs, REPO, "window-demo", MARKETPLACE, "window-demo");
};

const createScenario = async (): Promise<Scenario> => {
	const harness = createMemoryRuntime();
	harness.fs.seed(SETTINGS_PATH, "{}\n");
	seedDemo(harness, []);
	const state: RigState = {
		mode: "dev",
		paths: { repo: REPO, hub: HUB },
		features: { demo: true },
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	const first = await applyRig(harness.runtime, { state, mode: "install" });
	if (!first.ok) throw new Error(first.error);
	return {
		harness,
		run: async () => {
			const result = await applyCommand(harness.runtime, () => undefined);
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		},
	};
};

// Makes the fake `claude plugin marketplace list` report a marketplace registered from the plugin folder under another name.
const reportMarketplaces = (harness: MemoryRuntimeHarness, entries: Array<{ name: string; path?: string }>): void => {
	const original = harness.runtime.process.run;
	harness.runtime.process.run = async (command, args, options) => {
		if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
			return ok({ stdout: JSON.stringify(entries), stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });
		}
		return original(command, args, options);
	};
};

describe("the apply summary counts every change apply made", () => {
	test("a truly no-op apply reports up to date", async () => {
		const scenario = await createScenario();
		expect(await scenario.run()).toEqual(UP_TO_DATE);
	});

	test("an apply whose only change is a plugin install and a marketplace add does not report up to date", async () => {
		const scenario = await createScenario();
		seedDemo(scenario.harness, [RIG_PLUGIN]);

		const data = await scenario.run();

		expect([...scenario.harness.installedPlugins]).toEqual([`window-demo@${MARKETPLACE}`]);
		expect(data).toEqual({ changedFiles: [], pluginChanges: { ...NO_PLUGIN_CHANGES, installed: [`window-demo@${MARKETPLACE}`], marketplacesAdded: [MARKETPLACE] } });
		// The fake claude list does not remember added marketplaces, so the second run is told about it.
		reportMarketplaces(scenario.harness, [{ name: MARKETPLACE }]);
		expect(await scenario.run()).toEqual(UP_TO_DATE);
	});

	test("an apply whose only change is a marketplace cleanup does not report up to date", async () => {
		const scenario = await createScenario();
		seedDemo(scenario.harness, [RIG_PLUGIN]);
		await scenario.run();
		reportMarketplaces(scenario.harness, [{ name: MARKETPLACE }, { name: STALE_MARKETPLACE, path: RIG_PLUGIN_PATH }]);

		const data = await scenario.run();

		expect(scenario.harness.processCalls.some((call) => call.args.join(" ") === `plugin marketplace remove ${STALE_MARKETPLACE}`)).toBe(true);
		expect(data).toEqual({ changedFiles: [], pluginChanges: { ...NO_PLUGIN_CHANGES, marketplacesRemoved: [STALE_MARKETPLACE] } });
	});

	test("an apply whose only change is a written asset does not report up to date", async () => {
		const scenario = await createScenario();
		seedFeature(scenario.harness.fs, REPO, featureManifest("demo", { assets: [{ sourcePath: "assets/note.md", targetPath: "notes/note.md" }] }));
		scenario.harness.fs.seed(`${REPO}/features/demo/assets/note.md`, "Note");

		const data = await scenario.run();

		expect(scenario.harness.fs.files.get(`${HOME}/.claude/notes/note.md`)).toBe("Note");
		expect(data).toEqual({ changedFiles: [`${HOME}/.claude/notes/note.md`], pluginChanges: NO_PLUGIN_CHANGES });
		expect(await scenario.run()).toEqual(UP_TO_DATE);
	});

	test("an apply whose only change is a plugin uninstall does not report up to date", async () => {
		const scenario = await createScenario();
		seedDemo(scenario.harness, [RIG_PLUGIN]);
		await scenario.run();
		seedDemo(scenario.harness, []);
		const data = await scenario.run();

		expect([...scenario.harness.installedPlugins]).toEqual([]);
		expect(data.pluginChanges.uninstalled).toEqual([`window-demo@${MARKETPLACE}`]);
	});
});
