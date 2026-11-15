import type { ProgressEvent } from "../src/output.js";
import type { MemoryRuntimeHarness } from "./fakes/memory-runtime.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { renderFailure } from "../src/output.js";
import { messagesFor } from "../src/messages.js";
import { readStoredLanguage } from "../src/state.js";
import { baseManifest, createMemoryRuntime, featureManifest, seedFeature } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const HUB = "/hub";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const EVENTS_PATH = `${HOME}/.agent-rig/events.jsonl`;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;

type Run = { code: number; output: string[] };

const failure = (code: string, message: string): string => renderFailure({ code, message });

const setup = (language?: "en" | "ru"): MemoryRuntimeHarness => {
	const harness = createMemoryRuntime();
	seedFeature(harness.fs, REPO, baseManifest());
	seedFeature(harness.fs, REPO, featureManifest("demo"));
	seedFeature(harness.fs, REPO, featureManifest("windows-only", { platforms: ["windows"] }));
	writeState(harness, language);
	return harness;
};

const writeState = (harness: MemoryRuntimeHarness, language?: string): void => {
	const state = {
		mode: "dev",
		paths: { repo: REPO, hub: HUB },
		features: { demo: false },
		records: {},
		badPairs: [],
		pendingHubRestart: null,
		...(language === undefined ? {} : { language }),
	};
	harness.fs.seed(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
};

// The real runtime reads the language from state.json when it is built; this does the same for the memory runtime.
const run = async (harness: MemoryRuntimeHarness, args: string[], progress: ProgressEvent[] = []): Promise<Run> => {
	const output: string[] = [];
	harness.runtime.language = await readStoredLanguage(harness.fs, HOME);
	const code = await runCli(args, (line) => output.push(line), harness.runtime, undefined, (event) => progress.push(event));
	return { code, output };
};

const readEvents = (harness: MemoryRuntimeHarness): Array<{ type: string; text: string }> => {
	const text = harness.fs.files.get(EVENTS_PATH) ?? "";
	return text.split("\n").filter((line) => line.length > 0).map((line) => {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || !("text" in parsed)) throw new Error("bad event");
		return { type: String(parsed.type), text: String(parsed.text) };
	});
};

const storedLanguageValue = (harness: MemoryRuntimeHarness): unknown => {
	const parsed: unknown = JSON.parse(harness.fs.files.get(STATE_PATH) ?? "{}");
	return typeof parsed === "object" && parsed !== null && "language" in parsed ? parsed.language : undefined;
};

describe("rig language", () => {
	test("prints the current language in that language, English when the state has none", async () => {
		const harness = setup();

		const result = await run(harness, ["language"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"en"}'] });
	});

	test("prints the current language as raw data when the state says ru", async () => {
		const harness = setup("ru");

		const result = await run(harness, ["language"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"ru"}'] });
	});

	test("setting ru stores it, emits language-changed in the new language and answers the raw language", async () => {
		const harness = setup();

		const result = await run(harness, ["language", "ru"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"ru","changed":true}'] });
		expect(storedLanguageValue(harness)).toBe("ru");
		expect(readEvents(harness)).toEqual([{ type: "language-changed", text: "\u042f\u0437\u044b\u043a: \u0440\u0443\u0441\u0441\u043a\u0438\u0439." }]);
		expect((await run(harness, ["language"])).output).toEqual(['{"language":"ru"}']);
	});

	test("setting en back emits the event in English", async () => {
		const harness = setup("ru");

		const result = await run(harness, ["language", "en"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"en","changed":true}'] });
		expect(storedLanguageValue(harness)).toBe("en");
		expect(readEvents(harness)).toEqual([{ type: "language-changed", text: "Language: English." }]);
	});

	test("setting the current value is a successful no-op: no event, the state file is not rewritten", async () => {
		const harness = setup();
		const before = harness.fs.files.get(STATE_PATH);

		const same = await run(harness, ["language", "en"]);

		expect(same.code).toBe(SUCCESS_EXIT_CODE);
		expect(same.output).toEqual(['{"language":"en","changed":false}']);
		expect(readEvents(harness)).toEqual([]);
		expect(harness.fs.files.get(STATE_PATH)).toBe(before);
	});

	test("--json is accepted and changes nothing: the language object and nothing else", async () => {
		const harness = setup();

		expect(await run(harness, ["language", "--json"])).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"en"}'] });
		await run(harness, ["language", "ru"]);
		expect(await run(harness, ["language", "--json"])).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"ru"}'] });
	});

	test("an unknown language or extra arguments are a usage error that lists en|ru", async () => {
		const harness = setup();
		const stateBefore = harness.fs.files.get(STATE_PATH);

		for (const args of [["language", "de"], ["language", "en", "ru"], ["language", "--yaml"]]) {
			const result = await run(harness, args);
			expect(result).toEqual({ code: FAILURE_EXIT_CODE, output: [failure("usage", "Usage: rig language [en|ru] [--json]")] });
		}
		expect(harness.fs.files.get(STATE_PATH)).toBe(stateBefore);
		expect(harness.fs.files.has(EVENTS_PATH)).toBe(false);
		expect(storedLanguageValue(harness)).toBeUndefined();
	});

	test("the usage error is printed in the stored language", async () => {
		const harness = setup("ru");

		const result = await run(harness, ["language", "de"]);

		expect(result.code).toBe(FAILURE_EXIT_CODE);
		expect(result.output.join("\n")).toContain("Использование: rig language");
	});

	test("the help line lists the language command", async () => {
		const harness = setup();

		const result = await run(harness, ["help"]);

		expect(result.output.join("\n")).toContain("language [en|ru] [--json]");
	});

	test("setting the language waits for and then takes the same rig lock", async () => {
		const harness = setup();
		harness.fs.seed(`${HOME}/.agent-rig/rig.lock`, JSON.stringify({ pid: 4242, startTime: 777 }));
		let sleeps = 0;
		harness.runtime.lock = {
			fs: harness.fs,
			home: HOME,
			process: { pid: 1, startTime: 2, ownerStartTime: async () => ({ ok: true as const, value: 777 }) },
			clock: {
				sleep: async () => {
					sleeps += 1;
					harness.fs.files.delete(`${HOME}/.agent-rig/rig.lock`);
				},
				now: () => Date.now(),
			},
			pollIntervalMs: 1,
		};

		const progress: ProgressEvent[] = [];
		const result = await run(harness, ["language", "ru"], progress);

		expect(sleeps).toBe(1);
		expect(result.output).toEqual(['{"language":"ru","changed":true}']);
		expect(progress).toEqual([{ code: "lock-waiting" }]);
	});
});

describe("output follows the stored language", () => {
	test("status is raw data with the same shape in both languages, with or without --json", async () => {
		const harness = setup();
		const keys = ["schemaVersion", "mode", "versions", "releases", "features", "lastUpdate", "pendingHubRestart", "errors"];

		const english = await run(harness, ["status"]);
		expect((await run(harness, ["status", "--json"])).output).toEqual(english.output);
		await run(harness, ["language", "ru"]);
		const russian = await run(harness, ["status"]);

		for (const result of [english, russian]) {
			expect(result.code).toBe(SUCCESS_EXIT_CODE);
			expect(result.output).toHaveLength(1);
			const parsed: unknown = JSON.parse(result.output[0] ?? "");
			expect(typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : []).toEqual(keys);
			expect(parsed).toMatchObject({ mode: "dev", pendingHubRestart: null });
		}
	});

	test("rig feature prints the raw list with the description in the current language, with or without --json", async () => {
		const harness = setup();

		const english = await run(harness, ["feature"]);
		expect(english.output).toHaveLength(1);
		expect(JSON.parse(english.output[0] ?? "")).toEqual({ features: [
			{ name: "demo", description: "Feature demo", enabled: false, platformAllowed: true },
			{ name: "windows-only", description: "Feature windows-only", enabled: false, platformAllowed: false },
		] });
		expect((await run(harness, ["feature", "--json"])).output).toEqual(english.output);

		await run(harness, ["language", "ru"]);
		const russian = await run(harness, ["feature", "--json"]);
		expect(JSON.parse(russian.output[0] ?? "")).toEqual({ features: [
			{ name: "demo", description: "Feature demo (ru)", enabled: false, platformAllowed: true },
			{ name: "windows-only", description: "Feature windows-only (ru)", enabled: false, platformAllowed: false },
		] });
	});

	test("a feature change prints raw data in both languages and writes its event in the stored language", async () => {
		const english = setup();
		const englishRun = await run(english, ["feature", "demo", "enable"]);
		expect(englishRun.output).toEqual(['{"feature":"demo","enabled":true}']);
		expect(readEvents(english).map((event) => event.text)).toContain("Feature demo enabled.");

		const russian = setup("ru");
		const russianRun = await run(russian, ["feature", "demo", "enable"]);
		expect(russianRun.output).toEqual(['{"feature":"demo","enabled":true}']);
		expect(readEvents(russian).map((event) => event.text)).toContain("\u0424\u0438\u0447\u0430 demo \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u0430.");
	});

	test("the update command reports its dev-mode failure in the stored language", async () => {
		const english = setup();
		const englishRun = await run(english, ["update"]);
		expect(englishRun.code).not.toBe(SUCCESS_EXIT_CODE);
		expect(englishRun.output).toEqual([failure("update-failed", messagesFor("en").update.devUnavailable())]);

		const russian = setup("ru");
		const russianRun = await run(russian, ["update"]);
		expect(russianRun.output).toEqual([failure("update-failed", messagesFor("ru").update.devUnavailable())]);
		expect(messagesFor("ru").update.devUnavailable()).not.toBe(messagesFor("en").update.devUnavailable());
	});

	test("errors are printed in the stored language", async () => {
		const english = setup();
		const englishRun = await run(english, ["feature", "missing", "enable"]);
		expect(englishRun.output).toEqual([failure("unknown-feature", messagesFor("en").feature.unknown("missing"))]);

		const russian = setup("ru");
		const russianRun = await run(russian, ["feature", "missing", "enable"]);
		expect(russianRun.output).toEqual([failure("unknown-feature", messagesFor("ru").feature.unknown("missing"))]);
		expect(messagesFor("ru").feature.unknown("missing")).not.toBe(messagesFor("en").feature.unknown("missing"));
	});

	test("an unknown command is reported in English when the state has no language, in Russian when it says ru", async () => {
		expect((await run(setup(), ["nonsense"])).output).toEqual([failure("usage", messagesFor("en").cli.unknownCommand("nonsense"))]);
		expect((await run(setup("ru"), ["nonsense"])).output).toEqual([failure("usage", messagesFor("ru").cli.unknownCommand("nonsense"))]);
	});

	test("an unsupported language value in state.json is read as English by every command and changes nothing", async () => {
		const harness = setup();
		writeState(harness, "de");
		const stateBefore = harness.fs.files.get(STATE_PATH);

		const status = await run(harness, ["status"]);
		const shown = await run(harness, ["language"]);
		const features = await run(harness, ["feature"]);

		expect(status.code).toBe(SUCCESS_EXIT_CODE);
		expect(shown).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"en"}'] });
		expect(features.code).toBe(SUCCESS_EXIT_CODE);
		expect(harness.fs.files.get(STATE_PATH)).toBe(stateBefore);
		expect(harness.fs.files.has(EVENTS_PATH)).toBe(false);
	});

	test("`rig language en` repairs an unsupported stored value: a valid value is written, no language-changed event", async () => {
		const harness = setup();
		writeState(harness, "de");

		const result = await run(harness, ["language", "en"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"en","changed":false}'] });
		expect(storedLanguageValue(harness)).toBe("en");
		expect(readEvents(harness)).toEqual([]);
	});

	test("`rig language ru` replaces an unsupported stored value and records the change", async () => {
		const harness = setup();
		writeState(harness, "de");

		const result = await run(harness, ["language", "ru"]);

		expect(result).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"ru","changed":true}'] });
		expect(storedLanguageValue(harness)).toBe("ru");
		expect(readEvents(harness)).toEqual([{ type: "language-changed", text: "\u042f\u0437\u044b\u043a: \u0440\u0443\u0441\u0441\u043a\u0438\u0439." }]);
	});

	test("before install (no state.json) `rig language` says rig is not installed, in the current language, and writes nothing", async () => {
		for (const language of ["en", "ru"] as const) {
			for (const args of [["language"], ["language", "--json"], ["language", "ru"], ["language", "en"]]) {
				const harness = createMemoryRuntime();
				harness.runtime.language = language;
				const output: string[] = [];

				const code = await runCli(args, (line) => output.push(line), harness.runtime);

				const messages = messagesFor(language);
				expect({ args, code, output }).toEqual({ args, code: FAILURE_EXIT_CODE, output: [failure("not-installed", messages.language.notInstalled())] });
				expect(harness.fs.files.has(STATE_PATH)).toBe(false);
				expect(harness.fs.files.has(EVENTS_PATH)).toBe(false);
			}
		}
		expect(messagesFor("en").language.notInstalled()).not.toBe(messagesFor("ru").language.notInstalled());
	});

	test("the command takes the language from the runtime and does not read it from state.json again", async () => {
		const harness = setup();
		harness.runtime.language = "ru";
		const output: string[] = [];

		const code = await runCli(["language"], (line) => output.push(line), harness.runtime);

		expect({ code, output }).toEqual({ code: SUCCESS_EXIT_CODE, output: ['{"language":"ru"}'] });
	});

	test("help and a parse error are printed in the language the factory read, without building the runtime", async () => {
		let built = 0;
		const factory = {
			readLanguage: async () => "ru" as const,
			create: async () => {
				built += 1;
				return { ok: false as const, error: "must not be built" };
			},
		};

		const help: string[] = [];
		const helpCode = await runCli(["help"], (line) => help.push(line), undefined, factory);
		const bad: string[] = [];
		const badCode = await runCli(["nonsense"], (line) => bad.push(line), undefined, factory);

		expect(helpCode).toBe(SUCCESS_EXIT_CODE);
		expect(help).toHaveLength(1);
		expect(JSON.parse(help[0])).toHaveProperty("usage");
		expect(badCode).toBe(FAILURE_EXIT_CODE);
		expect(bad).toEqual([failure("usage", messagesFor("ru").cli.unknownCommand("nonsense"))]);
		expect(built).toBe(0);
	});
});
