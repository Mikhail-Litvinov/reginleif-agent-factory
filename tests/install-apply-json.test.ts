import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const SERVER_REPO = `${HOME}/.agent-rig/repo`;
const SERVER_HUB = `${HOME}/.agent-rig/hub`;
const SETTINGS_PATH = `${HOME}/.claude/settings.json`;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const SINGLE_LINE = 1;

const runJson = async (harness: MemoryRuntimeHarness, args: string[]): Promise<{ code: number; value: unknown; lines: number }> => {
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), harness.runtime);
	return { code, value: JSON.parse(output[0] ?? "null"), lines: output.length };
};

describe("rig install and rig apply print one JSON object", () => {
	test("a dev install returns paths, features, missing programs, changed files, plugin changes and the cron outcome", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, REPO, baseManifest());
		seedFeature(harness.fs, REPO, featureManifest("server-tools", {
			enabledByDefault: true,
			programs: [{ name: "tmux", command: "tmux", installCommand: "sudo apt-get install tmux", systemPackage: true }],
		}));
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		harness.unavailableCommands.add("tmux");

		const result = await runJson(harness, ["install", "--dev"]);

		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.lines).toBe(SINGLE_LINE);
		expect(result.value).toMatchObject({
			mode: "dev",
			paths: { repo: REPO },
			enabledFeatures: ["base", "server-tools"],
			missingPrograms: [{ name: "tmux", command: "sudo apt-get install tmux" }],
			pluginChanges: { installed: [], uninstalled: [], marketplacesAdded: [], marketplacesRemoved: [] },
			cron: "skipped",
		});
		const changed = typeof result.value === "object" && result.value !== null && "changedFiles" in result.value ? result.value.changedFiles : null;
		expect(Array.isArray(changed) && changed.length > 0).toBe(true);
	});

	test("a server install reports that it wrote the crontab", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, SERVER_REPO, baseManifest());
		harness.fs.seed(SETTINGS_PATH, "{}\n");

		const first = await runJson(harness, ["install"]);

		expect(first.value).toMatchObject({ mode: "server", paths: { repo: SERVER_REPO, hub: SERVER_HUB } });
		expect(first.code).toBe(SUCCESS_EXIT_CODE);
		const cronOf = (value: unknown): unknown => typeof value === "object" && value !== null && "cron" in value ? value.cron : null;
		expect(cronOf(first.value)).toBe("updated");
	});

	test("a failed install is the JSON error object with the install-failed code", async () => {
		const harness = createMemoryRuntime();

		const result = await runJson(harness, ["install"]);

		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(result.value).toEqual({ error: { code: "install-failed", message: expect.any(String) } });
	});

	test("apply returns the changed files and the plugin changes as data", async () => {
		const harness = createMemoryRuntime();
		seedFeature(harness.fs, SERVER_REPO, baseManifest());
		harness.fs.seed(SETTINGS_PATH, "{}\n");
		await runJson(harness, ["install"]);

		const result = await runJson(harness, ["apply"]);

		expect(result.code).toBe(SUCCESS_EXIT_CODE);
		expect(result.lines).toBe(SINGLE_LINE);
		expect(result.value).toEqual({
			changedFiles: [],
			pluginChanges: { installed: [], uninstalled: [], marketplacesAdded: [], marketplacesRemoved: [] },
		});
	});
});
