import type { ProcessOptions, ProcessOutput } from "../src/ports.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";

import { runService, serviceIsRunning, userBusEnvironment } from "../src/commands/real-runtime.js";
import { en } from "../src/messages.js";
import { ru } from "../src/messages-ru.js";
import { ok } from "../src/result.js";

const USER_ID = 1001;
const ACTIVE_EXIT_CODE = 0;
const BUS_FAILURE_EXIT_CODE = 1;
const INACTIVE_EXIT_CODE = 3;
const RUNTIME_DIRECTORY = "/run/user/1001";
const BUS_ADDRESS = "unix:path=/run/user/1001/bus";
const BUS_ERROR = "Failed to connect to user scope bus via local transport";

type Call = { command: string; args: readonly string[]; options: ProcessOptions | undefined };

type DetachedCall = { command: readonly string[]; graceMs: number; hide: boolean | undefined };
type DetachedOutcome = { exited: boolean; exitCode: number | null; stderr: string; pid?: number };

const fakeRunner = (exitCode: number, stderr = "", detached: DetachedOutcome = { exited: false, exitCode: null, stderr: "" }): {
	calls: Call[];
	detachedCalls: DetachedCall[];
	run: (command: string, args: readonly string[], options?: ProcessOptions) => Promise<Result<ProcessOutput>>;
	spawnDetached: (command: readonly string[], graceMs: number, stderrLimit: number, stderrPath: string, options?: { windowsHide?: boolean }) => Promise<Result<DetachedOutcome>>;
} => {
	const calls: Call[] = [];
	const detachedCalls: DetachedCall[] = [];
	return {
		calls,
		detachedCalls,
		run: async (command, args, options) => {
			calls.push({ command, args, options });
			return ok({ stdout: "", stderr, exitCode });
		},
		spawnDetached: async (command, graceMs, _stderrLimit, _stderrPath, options) => {
			detachedCalls.push({ command, graceMs, hide: options?.windowsHide });
			return ok(detached);
		},
	};
};

describe("systemctl --user under cron", () => {
	test("sets the user bus variables that are missing", () => {
		expect(userBusEnvironment({ environment: {}, uid: USER_ID })).toEqual({
			XDG_RUNTIME_DIR: RUNTIME_DIRECTORY,
			DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
		});
	});

	test("keeps variables that are already set", () => {
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "/custom", DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" }, uid: USER_ID })).toEqual({});
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "/custom" }, uid: USER_ID })).toEqual({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" });
	});

	test("treats empty variables as missing and sets nothing without a user id", () => {
		expect(userBusEnvironment({ environment: { XDG_RUNTIME_DIR: "", DBUS_SESSION_BUS_ADDRESS: "" }, uid: USER_ID })).toEqual({
			XDG_RUNTIME_DIR: RUNTIME_DIRECTORY,
			DBUS_SESSION_BUS_ADDRESS: BUS_ADDRESS,
		});
		expect(userBusEnvironment({ environment: {}, uid: null })).toEqual({});
	});

	test("the service query and restart pass the bus variables to systemctl", async () => {
		const query = fakeRunner(ACTIVE_EXIT_CODE);
		const restart = fakeRunner(ACTIVE_EXIT_CODE);
		const source = { environment: {}, uid: USER_ID };

		await serviceIsRunning(query, "linux", source);
		await runService(restart, "linux", "restart", source);

		expect(query.calls[0]?.options?.environment?.XDG_RUNTIME_DIR).toBe(RUNTIME_DIRECTORY);
		expect(restart.calls[0]?.options?.environment?.DBUS_SESSION_BUS_ADDRESS).toBe(BUS_ADDRESS);
	});

	test("is-active exit 0 is running, exit 3 is stopped", async () => {
		const source = { environment: {}, uid: USER_ID };

		expect(await serviceIsRunning(fakeRunner(ACTIVE_EXIT_CODE), "linux", source)).toEqual(ok(true));
		expect(await serviceIsRunning(fakeRunner(INACTIVE_EXIT_CODE), "linux", source)).toEqual(ok(false));
	});

	test("a missing Scheduled Task is reported from the catalog in the current language", async () => {
		const source = { environment: {}, uid: USER_ID };
		const missing = fakeRunner(BUS_FAILURE_EXIT_CODE);

		const english = await serviceIsRunning(missing, "windows", source, en);
		const russian = await serviceIsRunning(missing, "windows", source, ru);

		expect(english).toEqual({ ok: false, error: en.runtime.scheduledTaskNotFound() });
		expect(russian).toEqual({ ok: false, error: ru.runtime.scheduledTaskNotFound() });
		expect(en.runtime.scheduledTaskNotFound()).not.toBe(ru.runtime.scheduledTaskNotFound());
	});

	test("a bus connection failure is an error with systemctl's message, not a stopped service", async () => {
		const result = await serviceIsRunning(fakeRunner(BUS_FAILURE_EXIT_CODE, BUS_ERROR), "linux", { environment: {}, uid: USER_ID });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(BUS_ERROR);
	});
});

describe("hub restart on Windows", () => {
	const source = { environment: {}, uid: USER_ID };

	test("runs detached and hidden, so stopping the task's job cannot end the restart", async () => {
		const runner = fakeRunner(ACTIVE_EXIT_CODE);

		expect(await runService(runner, "windows", "restart", source, en)).toEqual(ok(undefined));

		expect(runner.calls).toEqual([]);
		expect(runner.detachedCalls).toHaveLength(1);
		expect(runner.detachedCalls[0]?.command.join(" ")).toContain("Stop-ScheduledTask");
		expect(runner.detachedCalls[0]?.command.join(" ")).toContain("Start-ScheduledTask");
		expect(runner.detachedCalls[0]?.hide).toBe(true);
	});

	test("a restart that fails inside the grace period reports its stderr under the catalog label", async () => {
		const runner = fakeRunner(ACTIVE_EXIT_CODE, "", { exited: true, exitCode: BUS_FAILURE_EXIT_CODE, stderr: BUS_ERROR });

		const result = await runService(runner, "windows", "restart", source, ru);

		expect(result).toEqual({ ok: false, error: `${ru.runtime.taskRestartLabel()}: ${BUS_ERROR}` });
	});
});
