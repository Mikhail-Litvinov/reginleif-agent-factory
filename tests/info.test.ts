import type { RigState } from "../src/state.js";
import type { RuntimePorts } from "../src/ports.js";
import type { Result } from "../src/result.js";
import type { ProcessOutput } from "../src/ports.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { parseRolloutLimits } from "../src/codex-rollout.js";
import { PROCESS_FAILURE_EXIT_CODE, PROCESS_SUCCESS_EXIT_CODE } from "../src/ports.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const REPO = "/repo";
const STATE_PATH = `${HOME}/.agent-rig/state.json`;
const SESSIONS = `${HOME}/.agent-rig/sessions`;
const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SECONDS = 1000;
const FAILURE_EXIT_CODE = 1;
const SCRIPT_FAILURE_CODE = 2;
const TOOLS_DIRECTORY = `${REPO}/features/volunteers/tools`;
const ROLLOUT_DIRECTORY = `${HOME}/.codex/sessions/2026/10/29`;
const OWN_ID = "11111111-aaaa";
const SAME_ACCOUNT_ID = "22222222-bbbb";
const OTHER_ACCOUNT_ID = "33333333-cccc";
const OWN_DIRECTORY = "/cfg/1-own";
const SAME_ACCOUNT_DIRECTORY = "/cfg/1-twin";
const OTHER_ACCOUNT_DIRECTORY = "/cfg/2-other";

type Harness = ReturnType<typeof createMemoryRuntime>;
type Tool = { accounts: Record<string, number | null>; allowed: Record<string, boolean>; volunteers: () => Result<ProcessOutput> };

const iso = (ms: number): string => new Date(ms).toISOString();

const seedState = (harness: Harness, features: Record<string, boolean>): void => {
	const state: RigState = { mode: "dev", paths: { repo: REPO, hub: "/hub" }, features, records: {}, badPairs: [], pendingHubRestart: null };
	harness.fs.seed(STATE_PATH, JSON.stringify(state));
};

const seedSession = (harness: Harness, id: string, configDir: string, usage?: unknown): void => {
	harness.fs.seed(`${SESSIONS}/${id}.json`, JSON.stringify({ session_id: id, config_dir: configDir }));
	if (usage !== undefined) harness.fs.seed(`${SESSIONS}/${id}/usage.json`, JSON.stringify(usage));
};

const claudeUsage = (at: number, fiveHour: number, week: number, resetFive: number, resetWeek: number, context: unknown = { tokens: 120000, breakdown: { totalTokens: 118000, autoCompactThreshold: 300000, isAutoCompactEnabled: true } }): unknown => ({
	at: iso(at),
	context,
	rateLimits: [
		{ kind: "seven_day", percentUsed: week, resetsAt: iso(resetWeek) },
		{ kind: "five_hour", percentUsed: fiveHour, resetsAt: iso(resetFive) },
	],
});

const stdout = (value: unknown): Result<ProcessOutput> => ok({ stdout: JSON.stringify(value), stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE });

// The runtime whose python calls (the allowlist tool and the volunteer script) are answered from `tool`.
const withTool = (harness: Harness, tool: Tool, language: RuntimePorts["language"] = "en"): RuntimePorts => ({
	...harness.runtime,
	language,
	process: {
		...harness.runtime.process,
		run: async (command, args) => {
			harness.processCalls.push({ command, args });
			const [, script, subcommand, third, fourth] = args;
			if (script.endsWith("account-allowlist.py") && subcommand === "account") {
				return stdout({ present: true, account: tool.accounts[fourth] ?? null });
			}
			if (script.endsWith("account-allowlist.py") && subcommand === "check") {
				return stdout({ allowed: tool.allowed[third] === true, reason: "" });
			}
			if (script.endsWith("volunteer-models.py")) return tool.volunteers();
			return ok({ stdout: "", stderr: "unexpected", exitCode: PROCESS_FAILURE_EXIT_CODE });
		},
	},
});

const noVolunteers = (): Result<ProcessOutput> => ok({ stdout: "", stderr: "", exitCode: PROCESS_FAILURE_EXIT_CODE });

const tool = (overrides: Partial<Tool> = {}): Tool => ({
	accounts: { [OWN_DIRECTORY]: 1, [SAME_ACCOUNT_DIRECTORY]: 1, [OTHER_ACCOUNT_DIRECTORY]: 2 },
	allowed: { codex: true, volunteers: true },
	volunteers: noVolunteers,
	...overrides,
});

const run = async (runtime: RuntimePorts, args: string[]): Promise<{ code: number; output: string[] }> => {
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), runtime);
	return { code, output };
};

const rolloutLine = (at: number, primary: unknown, secondary: unknown): string => JSON.stringify({
	timestamp: iso(at),
	type: "event_msg",
	payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary } },
});

const seedRollout = (harness: Harness, name: string, text: string): void => {
	harness.fs.seed(`${ROLLOUT_DIRECTORY}/${name}`, text);
};

const seedVolunteerScript = (harness: Harness): void => {
	harness.fs.seed(`${TOOLS_DIRECTORY}/volunteer-models.py`, "# stub");
};

const baseHarness = (features: Record<string, boolean>): Harness => {
	const harness = createMemoryRuntime();
	seedState(harness, features);
	return harness;
};

describe("rig info", () => {
	test("prints every block in the hub's order: freshest same-account Claude limits, Codex, volunteers, context", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 10 * MINUTE, 10, 40, NOW + 150 * MINUTE, NOW + 3 * DAY));
		seedSession(harness, SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY, claudeUsage(NOW - 2 * MINUTE, 25.5, 41, NOW + HOUR, NOW + 3 * DAY));
		seedSession(harness, OTHER_ACCOUNT_ID, OTHER_ACCOUNT_DIRECTORY, claudeUsage(NOW - MINUTE, 99, 99, NOW + HOUR, NOW + 3 * DAY));
		seedRollout(harness, "rollout-2026-10-29T10-00-00-abc.jsonl", [
			rolloutLine(NOW - 5 * HOUR, { used_percent: 1, window_minutes: 300 }, null),
			rolloutLine(NOW - HOUR, { used_percent: 12.4, window_minutes: 300, resets_at: (NOW + 30 * MINUTE) / SECONDS }, { used_percent: 50, window_minutes: 10080, resets_at: (NOW - HOUR) / SECONDS }),
			"",
		].join("\n"));
		seedVolunteerScript(harness);
		const volunteers = (): Result<ProcessOutput> => stdout({
			source: "proxy",
			checked_at: iso(NOW - 6 * MINUTE),
			error: null,
			day_percent: 42.4,
			reset_in_s: 7200,
			providers: { openrouter: { used: 3, cap: 10 }, groq: { used: 1, cap: null }, custom: { used: 2, cap: 5 } },
		});

		const result = await run(withTool(harness, tool({ volunteers })), ["info", "--session", OWN_ID]);

		expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
		expect(result.output.join("\n")).toBe([
			"**Claude limits**",
			"5 hours: 25.5% (resets in 1 h)",
			"Week: 41% (resets in 3 d)",
			"",
			"**Codex limits** (data 1 h old)",
			"5 hours: 12% (resets in 30 min)",
			"Week: 0%",
			"",
			"**Volunteer limits** (data 6 min old)",
			"Day: 42% (resets in 1 h 54 min)",
			"OpenRouter: 3/10",
			"custom: 2/5",
			"",
			"**Context**",
			"120/300k",
		].join("\n"));
		const volunteerCall = harness.processCalls.find((call) => call.args.some((argument) => argument.endsWith("volunteer-models.py")));
		expect(volunteerCall?.args).toEqual(["-I", `${TOOLS_DIRECTORY}/volunteer-models.py`, "limits", "--json"]);
	});

	test("Codex and volunteer blocks are absent when the feature is off or the account is not allowed", async () => {
		const usage = claudeUsage(NOW, 10, 40, NOW + HOUR, NOW + DAY);
		const expected = ["**Claude limits**", "5 hours: 10% (resets in 1 h)", "Week: 40% (resets in 1 d)", "", "**Context**", "120/300k"].join("\n");

		const featureOff = baseHarness({ codex: false, volunteers: false });
		seedSession(featureOff, OWN_ID, OWN_DIRECTORY, usage);
		expect((await run(withTool(featureOff, tool()), ["info", "--session", OWN_ID])).output.join("\n")).toBe(expected);

		const refused = baseHarness({ codex: true, volunteers: true });
		seedSession(refused, OWN_ID, OWN_DIRECTORY, usage);
		const text = (await run(withTool(refused, tool({ allowed: { codex: false, volunteers: false } })), ["info", "--session", OWN_ID])).output.join("\n");
		expect(text).toBe(expected);
		const check = refused.processCalls.find((call) => call.args[2] === "check");
		expect(check?.args).toEqual(["-I", `${REPO}/base/tools/account-allowlist.py`, "check", "codex", "--config-dir", OWN_DIRECTORY]);
	});

	test("an account that cannot be determined uses only the session's own Claude limits", async () => {
		const harness = baseHarness({});
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 20 * MINUTE, 10, 40, NOW + HOUR, NOW + DAY));
		seedSession(harness, SAME_ACCOUNT_ID, SAME_ACCOUNT_DIRECTORY, claudeUsage(NOW, 77, 78, NOW + HOUR, NOW + DAY));

		const text = (await run(withTool(harness, tool({ accounts: {} })), ["info", "--session", OWN_ID])).output.join("\n");

		expect(text).toContain("**Claude limits** (data 20 min old)\n5 hours: 10% (resets in 1 h)");
		expect(text).not.toContain("77");
	});

	test("the data age appears from 5 minutes and not before", async () => {
		const fresh = baseHarness({});
		seedSession(fresh, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 5 * MINUTE + 1, 10, 40, NOW + HOUR, NOW + DAY));
		expect((await run(withTool(fresh, tool()), ["info", "--session", OWN_ID])).output[0]).toMatch(/^\*\*Claude limits\*\*\n/);

		const stale = baseHarness({});
		seedSession(stale, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 5 * MINUTE, 10, 40, NOW + HOUR, NOW + DAY));
		expect((await run(withTool(stale, tool()), ["info", "--session", OWN_ID])).output[0]).toMatch(/^\*\*Claude limits\*\* \(data 5 min old\)\n/);
	});

	test("a session without data prints the no-data lines and still succeeds", async () => {
		const harness = baseHarness({ codex: true, volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);

		const result = await run(withTool(harness, tool()), ["info", "--session", OWN_ID]);

		expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
		expect(result.output.join("\n")).toBe([
			"Claude limits: no data, they appear after the model's first reply",
			"",
			"Codex limits: no data, no Codex rollout with limits yet",
			"",
			"Volunteer limits: no data, volunteer-models.py not found",
			"",
			"**Context**",
			"no data",
		].join("\n"));
	});

	test("a failing volunteer script becomes a reason line", async () => {
		const cases: Array<[() => Result<ProcessOutput>, string]> = [
			[() => ok({ stdout: "", stderr: "boom\n", exitCode: SCRIPT_FAILURE_CODE }), "Volunteer limits: no data, script exited with code 2: boom"],
			[() => ok({ stdout: "", stderr: "", exitCode: SCRIPT_FAILURE_CODE }), "Volunteer limits: no data, script exited with code 2: no stderr"],
			[() => ok({ stdout: "not json", stderr: "", exitCode: PROCESS_SUCCESS_EXIT_CODE }), "Volunteer limits: no data, bad JSON from script"],
			[() => stdout({ source: "none", error: "proxy is down" }), "Volunteer limits: no data, proxy is down"],
			[() => stdout({ source: "none", error: null }), "Volunteer limits: no data, no data source"],
		];
		for (const [volunteers, line] of cases) {
			const harness = baseHarness({ volunteers: true });
			seedSession(harness, OWN_ID, OWN_DIRECTORY);
			seedVolunteerScript(harness);
			const result = await run(withTool(harness, tool({ volunteers })), ["info", "--session", OWN_ID]);
			expect(result.code).toBe(PROCESS_SUCCESS_EXIT_CODE);
			expect(result.output.join("\n")).toContain(line);
		}
	});

	test("the volunteer day line reads 0% once its reset has passed", async () => {
		const harness = baseHarness({ volunteers: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedVolunteerScript(harness);
		const volunteers = (): Result<ProcessOutput> => stdout({ source: "quota-file", checked_at: iso(NOW - HOUR), day_percent: 80, reset_in_s: 60, providers: {} });

		const text = (await run(withTool(harness, tool({ volunteers })), ["info", "--session", OWN_ID])).output.join("\n");

		expect(text).toContain("**Volunteer limits** (data 1 h old)\nDay: 0%\n\n**Context**");
	});

	test("context shows an estimate mark and the plain token count without auto-compact", async () => {
		const estimated = baseHarness({});
		seedSession(estimated, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { breakdown: { totalTokens: 90400, autoCompactThreshold: 300000, isAutoCompactEnabled: true } }));
		expect((await run(withTool(estimated, tool()), ["info", "--session", OWN_ID])).output.join("\n")).toEndWith("**Context**\n≈90/300k");

		const plain = baseHarness({});
		seedSession(plain, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { breakdown: { totalTokens: 1_540_000, isAutoCompactEnabled: false } }));
		expect((await run(withTool(plain, tool()), ["info", "--session", OWN_ID])).output.join("\n")).toEndWith("**Context**\n≈1.5M");

		const exact = baseHarness({});
		seedSession(exact, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW, 1, 2, NOW + HOUR, NOW + HOUR, { tokens: 45600 }));
		expect((await run(withTool(exact, tool()), ["info", "--session", OWN_ID])).output.join("\n")).toEndWith("**Context**\n46k");
	});

	test("the text is Russian when rig's language is Russian", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY, claudeUsage(NOW - 10 * MINUTE, 10, 40, NOW + 90 * MINUTE, NOW + 2 * DAY + 5 * HOUR));

		const text = (await run(withTool(harness, tool(), "ru"), ["info", "--session", OWN_ID])).output.join("\n");

		expect(text).toBe([
			"**Лимиты Claude** (данные 10 мин назад)",
			"5 часов: 10% (сброс через 1 ч 30 мин)",
			"Неделя: 40% (сброс через 2 д 5 ч)",
			"",
			"Лимиты Codex: нет данных — в сессиях Codex ещё нет лимитов",
			"",
			"**Контекст**",
			"120/300k",
		].join("\n"));
	});

	test("a bad or unknown session id is an error exit with a clear message", async () => {
		const harness = baseHarness({});
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		const runtime = withTool(harness, tool());

		for (const id of ["../x", "a/b", "a\\b", ".hidden", "a..b", " "]) {
			const result = await run(runtime, ["info", "--session", id]);
			expect(result).toEqual({ code: FAILURE_EXIT_CODE, output: [`rig error: Not a valid session id: ${id}`] });
		}
		expect(await run(runtime, ["info", "--session", "missing-id"])).toEqual({ code: FAILURE_EXIT_CODE, output: ["rig error: Unknown session: missing-id"] });
		expect(await run(runtime, ["info"])).toEqual({ code: FAILURE_EXIT_CODE, output: ["Usage: rig info --session <id>"] });
		expect(await run(runtime, ["info", "--session"])).toEqual({ code: FAILURE_EXIT_CODE, output: ["Usage: rig info --session <id>"] });
	});
});

describe("Codex rollout parsing", () => {
	test("takes the last rate-limit event and maps window minutes to kinds", () => {
		const text = [
			rolloutLine(NOW - HOUR, { used_percent: 5, window_minutes: 300 }, null),
			"{\"broken\": \"rate_limits\"",
			rolloutLine(NOW, { used_percent: 7, window_minutes: 90, resets_at: 1000 }, { used_percent: 9, window_minutes: 10080 }),
			JSON.stringify({ timestamp: iso(NOW), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "other", primary: { used_percent: 1, window_minutes: 300 } } } }),
		].join("\n");

		expect(parseRolloutLimits(text)).toEqual({
			at: NOW,
			limits: [{ kind: "90m", percent: 7, resetsAt: 1_000_000 }, { kind: "seven_day", percent: 9, resetsAt: null }],
		});
	});

	test("skips events with invalid windows and text without events", () => {
		expect(parseRolloutLimits(rolloutLine(NOW, { used_percent: -1, window_minutes: 300 }, { used_percent: 1, window_minutes: 0 }))).toBeNull();
		expect(parseRolloutLimits("no events here\n")).toBeNull();
	});

	test("an older rollout answers when the newest one has no limits yet", async () => {
		const harness = baseHarness({ codex: true });
		seedSession(harness, OWN_ID, OWN_DIRECTORY);
		seedRollout(harness, "rollout-2026-10-29T09-00-00-old.jsonl", `${rolloutLine(NOW - 2 * HOUR, { used_percent: 33, window_minutes: 300, resets_at: (NOW + HOUR) / SECONDS }, null)}\n`);
		seedRollout(harness, "rollout-2026-10-29T11-00-00-new.jsonl", "{\"type\":\"session_meta\"}\n");

		const text = (await run(withTool(harness, tool()), ["info", "--session", OWN_ID])).output.join("\n");

		expect(text).toContain("**Codex limits** (data 2 h old)\n5 hours: 33% (resets in 1 h)");
	});
});
