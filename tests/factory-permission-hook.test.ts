import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PERMISSION_HOOK_TIMEOUT_SECONDS, runPermissionHook, type PermissionHookDependencies } from "../features/factory/hooks/permission.js";

const environment = { AF_API_URL: "https://factory.invalid/api", AF_REGISTRY_TOKEN: "registry-secret" };
const payload = { session_id: "session-1", tool_name: "Bash", tool_input: { command: "ls" } };

type Call = { method: string; path: string; body: unknown; authorization: string | null };
const json = (body: unknown, status = 200) => Response.json(body, { status });

const setup = (handler: (call: Call) => Response | Promise<Response>, env: Record<string, string | undefined> = environment) => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const calls: Call[] = [];
	let now = 0;
	const dependencies: PermissionHookDependencies = {
		environment: () => env,
		transport: async (url, init) => {
			const call: Call = {
				method: init?.method ?? "GET",
				path: url.replace("https://factory.invalid/api/", ""),
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				authorization: new Headers(init?.headers).get("Authorization"),
			};
			calls.push(call);
			return handler(call);
		},
		clock: { now: () => now },
		sleep: async (milliseconds) => { now += milliseconds; },
		writeStdout: (line) => stdout.push(line),
		writeStderr: (line) => stderr.push(line),
	};
	return { dependencies, stdout, stderr, calls };
};

const decision = (stdout: string[]) => {
	expect(stdout).toHaveLength(1);
	return JSON.parse(stdout[0] as string).hookSpecificOutput as { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
};

describe("Factory permission hook", () => {
	test("allow from a record lets the call through and sends the right shape", async () => {
		const { dependencies, stdout, stderr, calls } = setup(() => json({ allowed: true, source: "record", ref: "7" }));
		expect(await runPermissionHook(payload, dependencies)).toBe(0);
		expect(decision(stdout).permissionDecision).toBe("allow");
		expect(stderr).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "POST", path: "rights/check", authorization: "Bearer registry-secret" });
		expect(calls[0]?.body).toEqual({ session_id: "session-1", action: "tool", target: "Bash", conditions: { tool_input: { command: "ls" } } });
	});

	test("refused denies with the reason", async () => {
		const { dependencies, stdout } = setup(() => json({ allowed: false, source: "refused", reason: "suspended" }));
		await runPermissionHook(payload, dependencies);
		const out = decision(stdout);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain("suspended");
	});

	test("none makes a request and an owner handover leaves the normal prompt", async () => {
		const { dependencies, stdout, calls } = setup((call) => {
			if (call.path === "rights/check") return json({ allowed: false, source: "none" });
			if (call.path === "rights/requests") return json({ id: "req-1", state: "open" }, 202);
			return json({ id: "req-1", state: "call_owner" });
		});
		await runPermissionHook(payload, dependencies);
		expect(decision(stdout).permissionDecision).toBe("ask");
		expect(calls.map((call) => call.path)).toEqual(["rights/check", "rights/requests", "rights/requests/req-1"]);
	});

	test("a request waits, then a grant allows and a refusal denies", async () => {
		for (const [final, expected] of [["granted", "allow"], ["refused", "deny"]] as const) {
			let polls = 0;
			const { dependencies, stdout } = setup((call) => {
				if (call.path === "rights/check") return json({ allowed: false, source: "none" });
				if (call.method === "POST") return json({ id: "req-1", state: "open" }, 202);
				polls += 1;
				return json({ id: "req-1", state: polls < 3 ? "open" : final });
			});
			await runPermissionHook(payload, dependencies);
			expect(decision(stdout).permissionDecision).toBe(expected);
			expect(polls).toBe(3);
		}
	});

	test("a request still open at the limit is denied and never allows", async () => {
		const { dependencies, stdout } = setup((call) => {
			if (call.path === "rights/check") return json({ allowed: false, source: "none" });
			if (call.method === "POST") return json({ id: "req-1", state: "open" }, 202);
			return json({ id: "req-1", state: "open" });
		});
		await runPermissionHook(payload, dependencies);
		const out = decision(stdout);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain("req-1");
	});

	test("an unreachable factory falls back to the prompt with one line", async () => {
		const { dependencies, stdout, stderr } = setup(() => { throw new Error("connect refused"); });
		await runPermissionHook(payload, dependencies);
		expect(decision(stdout).permissionDecision).toBe("ask");
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain("unreachable");
	});

	test("a disabled registry (503) falls back to the prompt", async () => {
		const { dependencies, stdout } = setup(() => json({ code: "unavailable" }, 503));
		await runPermissionHook(payload, dependencies);
		expect(decision(stdout).permissionDecision).toBe("ask");
	});

	test("not configured falls back to the prompt without a call", async () => {
		for (const env of [{}, { AF_API_URL: environment.AF_API_URL }, { AF_REGISTRY_TOKEN: "x" }, { ...environment, AF_API_URL: "ftp://x" }]) {
			const { dependencies, stdout, stderr, calls } = setup(() => { throw new Error("transport must not run"); }, env);
			await runPermissionHook(payload, dependencies);
			expect(decision(stdout).permissionDecision).toBe("ask");
			expect(stderr).toHaveLength(1);
			expect(stderr[0]).toContain("not configured");
			expect(calls).toEqual([]);
		}
	});

	test("malformed answers never allow", async () => {
		const bodies: Array<[unknown, number]> = [
			["not an object", 200], [{}, 200], [{ allowed: "yes", source: "role" }, 200], [{ allowed: true }, 200],
			[{ allowed: true, source: "none" }, 200], [{ allowed: true, source: "refused" }, 200], [{ allowed: false, source: "mystery" }, 200],
			[{ allowed: true, source: "role" }, 201], [{ code: "forbidden" }, 403],
		];
		for (const [body, status] of bodies) {
			const { dependencies, stdout } = setup(() => json(body, status));
			await runPermissionHook(payload, dependencies);
			expect(decision(stdout).permissionDecision).toBe("ask");
		}
		const { dependencies, stdout } = setup(() => new Response("<html>", { status: 200 }));
		await runPermissionHook(payload, dependencies);
		expect(decision(stdout).permissionDecision).toBe("ask");
	});

	test("a malformed request state or request answer never allows", async () => {
		for (const state of ["maybe", 5, undefined]) {
			const { dependencies, stdout } = setup((call) => {
				if (call.path === "rights/check") return json({ allowed: false, source: "none" });
				if (call.method === "POST") return json({ id: "req-1", state: "open" }, 202);
				return json({ state });
			});
			await runPermissionHook(payload, dependencies);
			expect(decision(stdout).permissionDecision).toBe("ask");
		}
		const { dependencies, stdout } = setup((call) => call.path === "rights/check" ? json({ allowed: false, source: "none" }) : json({ nope: 1 }, 202));
		await runPermissionHook(payload, dependencies);
		expect(decision(stdout).permissionDecision).toBe("ask");
	});

	test("a Factory run has no prompt and is denied when the factory fails", async () => {
		const env = { ...environment, AF_TASK_RUN_ID: "run-1" };
		const { dependencies, stdout, calls } = setup(() => { throw new Error("down"); }, env);
		await runPermissionHook({ ...payload, session_id: undefined }, dependencies);
		expect(decision(stdout).permissionDecision).toBe("deny");
		expect(calls[0]?.body).toMatchObject({ run_id: "run-1" });
		const notConfigured = setup(() => json({}), { AF_TASK_RUN_ID: "run-1" });
		await runPermissionHook(payload, notConfigured.dependencies);
		expect(decision(notConfigured.stdout).permissionDecision).toBe("deny");
	});

	test("an unreadable tool call or unknown session never allows and makes no call", async () => {
		for (const bad of [{}, { tool_name: "Bash" }]) {
			const { dependencies, stdout, calls } = setup(() => json({ allowed: true, source: "role" }));
			await runPermissionHook(bad, dependencies);
			expect(decision(stdout).permissionDecision).toBe("ask");
			expect(calls).toEqual([]);
		}
	});

	test("the feature registers the hook with the limit the code waits against", () => {
		const feature = JSON.parse(readFileSync(new URL("../features/factory/feature.json", import.meta.url), "utf8")) as { hooks: Array<{ args: string[]; timeout: number }>; files: string[] };
		const hook = feature.hooks.find((entry) => entry.args.some((arg) => arg.endsWith("hooks/permission.ts")));
		expect(hook?.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SECONDS);
		expect(feature.files).toContain("hooks/permission.ts");
	});
});
