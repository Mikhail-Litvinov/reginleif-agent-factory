import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITIES } from "../../control/activity-catalog.ts";
import { createFakeAgentAdapter } from "./agent-adapter.ts";
import { ActivityError, type ActivityErrorKind, type ActivityOutput, ERROR_CLASS_OF, MACHINE_ACTIVITY_NAMES, type MachineActivityName, SAMPLE_INPUTS, SAMPLE_OUTPUTS, contractOf } from "./contracts.ts";
import { type MachineFakes, createMachineFakes } from "./machine-activities.ts";
import { type Behavior, type FakeActivity } from "./scripted.ts";

// Compile-time checks: the typecheck fails when one of them is false. Equals is the strict identity test, so a fake whose
// run returns a wider or narrower type than its contract's output is caught.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AllTrue<T extends Record<string, true>> = T;
type RunOutput<K extends MachineActivityName> = Awaited<ReturnType<MachineFakes[K]["run"]>>;
export type FakeRunsMatchContracts = AllTrue<{ readonly [K in MachineActivityName]: Equals<RunOutput<K>, ActivityOutput<K>> }>;
// The identity test must reject a real mismatch, or the check above proves nothing.
export type IdentityTestRejectsMismatch = AllTrue<{ readonly detected: Equals<string, number> extends false ? true : false }>;

const looseFakes = (machineId: string): Record<MachineActivityName, FakeActivity<MachineActivityName>> =>
	createMachineFakes(machineId) as unknown as Record<MachineActivityName, FakeActivity<MachineActivityName>>;

// A behavior whose beats or error kind are deliberately outside the contract, so the fake's refusal is what is tested.
const looseBehavior = (behavior: unknown): Behavior<MachineActivityName> => behavior as Behavior<MachineActivityName>;

const ALL_ERROR_KINDS = Object.keys(ERROR_CLASS_OF) as ActivityErrorKind[];

describe("machine activity fakes", () => {
	it("cover every activity whose place is machine or gpu", () => {
		const expected = Object.entries(ACTIVITIES)
			.filter(([, definition]) => definition.place !== "local")
			.map(([name]) => name)
			.sort();
		assert.deepEqual([...MACHINE_ACTIVITY_NAMES].sort(), expected);
	});

	it("listen on the catalog queues: machine-<id>, or machine-<id>-gpu for RunGpuJob", () => {
		const fakes = looseFakes("m7");
		for (const name of MACHINE_ACTIVITY_NAMES) {
			assert.equal(fakes[name].queue, name === "RunGpuJob" ? "machine-m7-gpu" : "machine-m7", name);
		}
	});

	for (const name of MACHINE_ACTIVITY_NAMES) {
		describe(name, () => {
			it("accepts its sample input and returns its sample output", async () => {
				const fake = looseFakes("m1")[name];
				assert.deepEqual(await fake.run(SAMPLE_INPUTS[name]), SAMPLE_OUTPUTS[name]);
			});

			it("rejects an input that breaks the contract", async () => {
				const fake = looseFakes("m1")[name];
				await assert.rejects(fake.run({ unexpected: true }));
			});

			it("refuses to script an error kind its contract does not allow", () => {
				const fake = looseFakes("m1")[name];
				const allowed = contractOf(name).errors;
				const disallowed = ALL_ERROR_KINDS.find((kind) => !allowed.includes(kind));
				assert.ok(disallowed !== undefined, "every error kind is allowed, so no refusal can be checked");
				assert.throws(() => fake.script(looseBehavior({ outcome: { kind: "fail", error: disallowed } })), /cannot fail with/);
			});

			it("fails with each error kind its contract allows, as an ActivityError of that class", async () => {
				const fake = looseFakes("m1")[name];
				const allowed = contractOf(name).errors as ActivityErrorKind[];
				fake.script(...allowed.map((error) => looseBehavior({ outcome: { kind: "fail", error } })));
				for (const error of allowed) {
					await assert.rejects(
						fake.run(SAMPLE_INPUTS[name]),
						(thrown: unknown) => thrown instanceof ActivityError && thrown.kind === error && thrown.errorClass === ERROR_CLASS_OF[error],
					);
				}
			});

			it("refuses a heartbeat the contract does not allow", () => {
				const fake = looseFakes("m1")[name];
				assert.throws(() =>
					fake.script(looseBehavior({ beats: [{ unexpected: true }], outcome: { kind: "succeed", output: SAMPLE_OUTPUTS[name] } })),
				);
			});

			it("hangs until its AbortSignal fires, then rejects with the abort reason", async () => {
				const fake = looseFakes("m1")[name];
				fake.script(looseBehavior({ outcome: { kind: "hang" } }));
				const controller = new AbortController();
				const pending = fake.run(SAMPLE_INPUTS[name], { signal: controller.signal });
				controller.abort(new Error("cancelled by test"));
				await assert.rejects(pending, /cancelled by test/);
			});

			it("refuses a hang that has no signal to cancel it, instead of blocking", async () => {
				const fake = looseFakes("m1")[name];
				fake.script(looseBehavior({ outcome: { kind: "hang" } }));
				await assert.rejects(fake.run(SAMPLE_INPUTS[name]), /has no signal to cancel it/);
			});

			it("answers a repeated key from its store only where the contract stores the result", async () => {
				const fake = looseFakes("m1")[name];
				const contract = contractOf(name);
				const input = SAMPLE_INPUTS[name];
				const first = await fake.run(input);
				const second = await fake.run(input);
				assert.deepEqual(second, first);
				const keyed = contract.key(input) !== undefined;
				const stored = keyed && contract.remember !== null && contract.remember(SAMPLE_OUTPUTS[name]) === true;
				assert.equal(fake.executed(), stored ? 1 : 2);
			});
		});
	}

	it("MonitorExecution records heartbeats that pass its contract, in order", async () => {
		const fake = looseFakes("m1").MonitorExecution;
		fake.script(
			looseBehavior({ beats: [{ executionId: "exec-1", logOffset: 0 }], outcome: { kind: "succeed", output: SAMPLE_OUTPUTS.MonitorExecution } }),
		);
		await fake.run(SAMPLE_INPUTS.MonitorExecution);
		assert.deepEqual(fake.heartbeats(), [{ executionId: "exec-1", logOffset: 0 }]);
	});
});

describe("agent adapter fake", () => {
	it("returns only the capabilities, environment checks and outcomes the test declared", async () => {
		const adapter = createFakeAgentAdapter();
		assert.deepEqual(await adapter.getCapabilities(), { roles: [], tools: [], kinds: [], resume: false, cancel: false });
		adapter.setCapabilities({ roles: ["implementer"], tools: ["shell"], kinds: ["codex"], resume: false, cancel: true });
		adapter.setChecks([{ name: "git", status: "pass" }]);
		assert.deepEqual(await adapter.getCapabilities(), { roles: ["implementer"], tools: ["shell"], kinds: ["codex"], resume: false, cancel: true });
		assert.deepEqual(await adapter.validateEnvironment(), [{ name: "git", status: "pass" }]);
		assert.equal(adapter.launches(), 0);
	});

	it("start is idempotent per executionId: a repeat returns the first launch and starts no process", async () => {
		const adapter = createFakeAgentAdapter();
		const first = await adapter.start("exec-1");
		assert.equal(await adapter.start("exec-1"), first);
		assert.equal(adapter.launches(), 1);
		await adapter.start("exec-2");
		assert.equal(adapter.launches(), 2);
	});

	it("attach answers only the outcome the test set; an unset outcome is an error", async () => {
		const adapter = createFakeAgentAdapter();
		await adapter.start("exec-1");
		await assert.rejects(adapter.attach("exec-1"), /no attach outcome/);
		adapter.setAttachOutcome("exec-1", "died");
		assert.equal(await adapter.attach("exec-1"), "died");
	});

	it("getStatus reports state and bytes; streamOutput reads from a byte offset; unknown runs are refused", async () => {
		const adapter = createFakeAgentAdapter();
		await assert.rejects(adapter.getStatus("exec-1"), /no run exec-1/);
		await adapter.start("exec-1");
		adapter.setState("exec-1", "running");
		adapter.appendOutput("exec-1", "café ");
		adapter.appendOutput("exec-1", "ok");
		assert.deepEqual(await adapter.getStatus("exec-1"), { state: "running", outputBytes: 8 });
		assert.deepEqual(await adapter.streamOutput("exec-1", 0), { chunks: [{ offset: 0, text: "café ok" }], nextOffset: 8 });
		assert.deepEqual(await adapter.streamOutput("exec-1", 6), { chunks: [{ offset: 6, text: "ok" }], nextOffset: 8 });
		assert.deepEqual(await adapter.streamOutput("exec-1", 8), { chunks: [], nextOffset: 8 });
		await assert.rejects(adapter.streamOutput("exec-1", 9), /outside the output/);
	});

	it("cancel is idempotent and reports whether the end is confirmed", async () => {
		const adapter = createFakeAgentAdapter();
		await adapter.start("exec-1");
		assert.deepEqual(await adapter.cancel("exec-1"), { endConfirmed: true });
		assert.deepEqual(await adapter.cancel("exec-1"), { endConfirmed: true });
		adapter.setCancelConfirmation("exec-1", false);
		assert.deepEqual(await adapter.cancel("exec-1"), { endConfirmed: false });
	});

	it("collectResult returns the outcome the test set; cleanup is recorded", async () => {
		const adapter = createFakeAgentAdapter();
		await adapter.start("exec-1");
		await assert.rejects(adapter.collectResult("exec-1"), /no collect outcome/);
		adapter.setCollectOutcome("exec-1", SAMPLE_OUTPUTS.CollectResults);
		assert.deepEqual(await adapter.collectResult("exec-1"), SAMPLE_OUTPUTS.CollectResults);
		assert.equal(adapter.cleaned("exec-1"), false);
		await adapter.cleanup("exec-1");
		assert.equal(adapter.cleaned("exec-1"), true);
	});
});
