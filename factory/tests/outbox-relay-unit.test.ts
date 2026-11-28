import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOutboxRelay, DEFAULT_LEASE_SECONDS, DEFAULT_RETRY_SECONDS, loadRelaySettings, type RelayTimers } from "../control/outbox-relay.ts";
import { fakeStore, fakeTemporal } from "./outbox-relay-fakes.ts";

// Timers that never wait: `every` records its period and returns a stop function, `sleep` returns at once.
const fakeTimers = () => {
	const periods: number[] = [];
	const ticks: (() => void)[] = [];
	let running = 0;
	const timers: RelayTimers = {
		every: (ms, fn) => { periods.push(ms); ticks.push(fn); running += 1; return () => { running -= 1; }; },
		sleep: async () => undefined,
	};
	return { timers, periods, ticks, running: () => running };
};

const setup = (settings: Record<string, unknown> = {}) => {
	const store = fakeStore(settings);
	const temporal = fakeTemporal();
	const t = fakeTimers();
	const calls: string[] = [];
	const effects = { stopRun: async (p: Record<string, unknown>) => { calls.push(`stop ${JSON.stringify(p)}`); }, cleanup: async (p: Record<string, unknown>) => { calls.push(`cleanup ${JSON.stringify(p)}`); } };
	const relay = createOutboxRelay({ repo: store.repo, workflows: temporal.client, effects, owner: "relay-a", timers: t.timers, clock: () => new Date("2030-01-01T00:00:00Z") });
	return { store, temporal, t, calls, relay };
};

describe("outbox relay routing", () => {
	it("starts a workflow for a CREATED task and marks the row sent", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "CREATED");
		store.addRow("r1", "start_workflow", { taskId: "t1" });
		const result = await relay.pressOnce();
		assert.deepEqual(result.rows.map((r) => r.outcome), ["sent"]);
		assert.deepEqual(temporal.log, ["start t1"]);
		assert.equal(store.rows.get("r1")!.state, "sent");
		assert.equal(store.rows.get("r1")!.leaseOwner, null);
	});

	it("does not start a final task, an already started one, or a task with a run id; the row is closed done", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("final", "ACCEPTED");
		store.addTask("started", "RUNNING");
		store.addTask("withrun", "CREATED", "run-1");
		for (const id of ["final", "started", "withrun"]) store.addRow(`r-${id}`, "start_workflow", { taskId: id });
		const result = await relay.pressOnce();
		assert.deepEqual(result.rows.map((r) => r.outcome), ["done", "done", "done"]);
		assert.deepEqual(temporal.log, []);
	});

	it("fails a start_workflow row whose task is gone", async () => {
		const { store, relay } = setup();
		store.addRow("r1", "start_workflow", { taskId: "ghost" });
		await relay.pressOnce();
		assert.equal(store.rows.get("r1")!.state, "failed");
		assert.equal(store.rows.get("r1")!.lastError, "task_missing");
	});

	it("delivers a decision as an Update carrying only the decision id and marks it delivering", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "RUNNING");
		store.addDecision("d1", "t1", "approve");
		store.addRow("r1", "deliver_decision", { taskId: "t1", decisionId: "d1" });
		await relay.pressOnce();
		assert.deepEqual(temporal.log, ["update approve d1"]);
		assert.equal(store.decisions.get("d1")!.deliveryState, "delivering");
		assert.equal(store.rows.get("r1")!.state, "sent");
	});

	it("refuses a decision of a closed task with task_closed and does not send it", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "CANCELLED");
		store.addDecision("d1", "t1", "approve");
		store.addRow("r1", "deliver_decision", { taskId: "t1", decisionId: "d1" });
		await relay.pressOnce();
		assert.deepEqual(temporal.log, []);
		assert.equal(store.decisions.get("d1")!.deliveryState, "refused");
		assert.equal(store.decisions.get("d1")!.refusalReason, "task_closed");
		assert.equal(store.rows.get("r1")!.state, "done");
	});

	it("keeps the applied outcome of a decision delivered again after the task closed", async () => {
		const { store, relay } = setup();
		store.addTask("t1", "ACCEPTED");
		store.addDecision("d1", "t1", "approve", "applied");
		store.addRow("r1", "deliver_decision", { taskId: "t1", decisionId: "d1" });
		await relay.pressOnce();
		assert.equal(store.decisions.get("d1")!.deliveryState, "applied");
		assert.equal(store.rows.get("r1")!.state, "done");
	});

	it("never sends a physical_decision as an Update", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "RUNNING");
		store.addDecision("d1", "t1", "physical_decision");
		store.addRow("r1", "deliver_decision", { taskId: "t1", decisionId: "d1" });
		await relay.pressOnce();
		assert.deepEqual(temporal.log, []);
		assert.equal(store.rows.get("r1")!.state, "failed");
	});

	it("wakes a workflow with a Signal, and closes the row when there is no workflow to wake", async () => {
		const { store, temporal, relay } = setup();
		store.addRow("w1", "wake", { taskId: "t1" });
		store.addRow("w2", "wake", { taskId: "t2" });
		await relay.pressOnce();
		assert.equal(store.rows.get("w1")!.state, "sent");
		temporal.failures.push(Object.assign(new Error("none"), { name: "WorkflowNotFoundError" }));
		store.addRow("w3", "wake", { taskId: "t3" });
		await relay.pressOnce();
		assert.equal(store.rows.get("w3")!.state, "done");
	});

	it("calls the injected stop_run and cleanup handlers with the payload and the task id", async () => {
		const { store, calls, relay } = setup();
		store.addRow("s1", "stop_run", { taskId: "t1", payload: { runId: "x" } });
		store.addRow("c1", "cleanup", { taskId: "t1", payload: { path: "p" } });
		await relay.pressOnce();
		assert.deepEqual(calls, ['stop {"runId":"x","taskId":"t1"}', 'cleanup {"path":"p","taskId":"t1"}']);
		assert.equal(store.rows.get("s1")!.state, "sent");
		assert.equal(store.rows.get("c1")!.state, "sent");
	});

	it("closes notify rows as done and fails an unknown kind", async () => {
		const { store, temporal, relay } = setup();
		store.addRow("n1", "notify", {});
		store.addRow("u1", "mystery", {});
		await relay.pressOnce();
		assert.equal(store.rows.get("n1")!.state, "done");
		assert.equal(store.rows.get("u1")!.state, "failed");
		assert.deepEqual(temporal.log, []);
	});

	it("delivers the rows of one round in seq order", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "CREATED");
		store.addRow("a", "wake", { taskId: "t1" });
		store.addRow("b", "start_workflow", { taskId: "t1" });
		store.addRow("c", "wake", { taskId: "t1" });
		await relay.pressOnce();
		assert.deepEqual(temporal.log, ["wake t1", "start t1", "wake t1"]);
	});
});

describe("outbox relay failure and lease", () => {
	it("releases a row whose delivery threw: it stays pending, leaves the lease and waits the retry delay", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "CREATED");
		store.addRow("r1", "start_workflow", { taskId: "t1" });
		temporal.failures.push(new Error("temporal down"));
		const first = await relay.pressOnce();
		assert.deepEqual(first.rows.map((r) => r.outcome), ["released"]);
		const row = store.rows.get("r1")!;
		assert.equal(row.state, "pending");
		assert.equal(row.leaseOwner, null);
		assert.match(row.lastError ?? "", /temporal down/);
		assert.equal(row.attempts, 1);
		// Not due before the retry delay, due after it.
		assert.equal((await relay.pressOnce()).claimed, 0);
		store.advance(DEFAULT_RETRY_SECONDS * 1000);
		assert.deepEqual((await relay.pressOnce()).rows.map((r) => r.outcome), ["sent"]);
		assert.equal(row.attempts, 2);
	});

	it("releases a stop_run row when no handler is configured", async () => {
		const store = fakeStore();
		const relay = createOutboxRelay({ repo: store.repo, workflows: fakeTemporal().client, owner: "a", timers: fakeTimers().timers });
		store.addRow("s1", "stop_run", { taskId: "t1" });
		assert.deepEqual((await relay.pressOnce()).rows.map((r) => r.outcome), ["released"]);
		assert.match(store.rows.get("s1")!.lastError ?? "", /no stopRun handler/);
	});

	it("reports lost when the lease was taken over before the mark, and writes nothing", async () => {
		const { store, relay } = setup();
		store.addTask("t1", "CREATED");
		store.addRow("r1", "start_workflow", { taskId: "t1" });
		// Another relay took the row over while this one was delivering.
		store.hooks.beforeMarkSent = () => { store.rows.get("r1")!.leaseOwner = "relay-b"; };
		const result = await relay.pressOnce();
		assert.deepEqual(result.rows.map((r) => r.outcome), ["lost"]);
		assert.equal(store.rows.get("r1")!.state, "pending");
		assert.equal(store.rows.get("r1")!.leaseOwner, "relay-b");
	});

	it("extends the lease three times per lease length while a delivery runs, and stops the heartbeat after it", async () => {
		const { store, t, relay } = setup();
		store.addTask("t1", "CREATED");
		store.addRow("r1", "start_workflow", { taskId: "t1" });
		await relay.pressOnce();
		assert.deepEqual(t.periods, [(DEFAULT_LEASE_SECONDS * 1000) / 3]);
		assert.equal(t.running(), 0);
		t.ticks[0]!();
		// The heartbeat of a finished delivery no longer owns the row, so it extends nothing.
		await Promise.resolve();
		assert.deepEqual(store.extended, []);
	});

	it("a heartbeat tick during the delivery extends the lease of the row in hand", async () => {
		const store = fakeStore();
		const t = fakeTimers();
		store.addRow("r1", "wake", { taskId: "t1" });
		const temporal = fakeTemporal();
		const slow = { ...temporal.client, wake: async () => { t.ticks[0]!(); await Promise.resolve(); } };
		const relay = createOutboxRelay({ repo: store.repo, workflows: slow, owner: "relay-a", timers: t.timers });
		await relay.pressOnce();
		assert.deepEqual(store.extended, ["r1"]);
	});

	it("takes the lease and retry lengths from settings and refuses a bad value", async () => {
		assert.deepEqual(await loadRelaySettings(fakeStore({ "relay.leaseSeconds": 5, "relay.retrySeconds": 2 }).repo.settings), { leaseSeconds: 5, retrySeconds: 2 });
		assert.deepEqual(await loadRelaySettings(fakeStore().repo.settings), { leaseSeconds: DEFAULT_LEASE_SECONDS, retrySeconds: DEFAULT_RETRY_SECONDS });
		await assert.rejects(loadRelaySettings(fakeStore({ "relay.leaseSeconds": 0 }).repo.settings), /relay\.leaseSeconds/);
		await assert.rejects(loadRelaySettings(fakeStore({ "relay.retrySeconds": 1.5 }).repo.settings), /relay\.retrySeconds/);
	});

	it("run() loops rounds until aborted and sleeps only when a round found nothing", async () => {
		const store = fakeStore();
		const sleeps: number[] = [];
		const controller = new AbortController();
		const timers: RelayTimers = { every: () => () => undefined, sleep: async (ms) => { sleeps.push(ms); store.addRow(`late${sleeps.length}`, "notify", {}); if (sleeps.length === 2) controller.abort(); } };
		const relay = createOutboxRelay({ repo: store.repo, workflows: fakeTemporal().client, owner: "a", timers });
		store.addRow("first", "notify", {});
		await relay.run(controller.signal, 250);
		assert.deepEqual(sleeps, [250, 250]);
		assert.equal(store.rows.get("first")!.state, "done");
		assert.equal(store.rows.get("late1")!.state, "done");
	});
});

describe("relay-press-once", () => {
	it("the same decision delivered twice has one effect, and a relay lost after the Update re-delivers into the same effect", async () => {
		const { store, temporal, relay } = setup();
		store.addTask("t1", "RUNNING");
		store.addDecision("d1", "t1", "approve");
		store.addRow("r1", "deliver_decision", { taskId: "t1", decisionId: "d1" });
		// The relay crashes after the Update, before mark-sent: its lease is taken over by the mark hook, then expires.
		store.hooks.beforeMarkSent = () => { store.rows.get("r1")!.leaseOwner = "dead"; };
		assert.deepEqual((await relay.pressOnce()).rows.map((r) => r.outcome), ["lost"]);
		store.hooks.beforeMarkSent = undefined;
		store.expireLease("r1");
		const again = createOutboxRelay({ repo: store.repo, workflows: temporal.client, owner: "relay-b", timers: fakeTimers().timers });
		assert.deepEqual((await again.pressOnce()).rows.map((r) => r.outcome), ["sent"]);
		assert.deepEqual(temporal.log, ["update approve d1", "update approve d1"]);
		assert.equal(temporal.updates.size, 1);
		assert.equal(store.decisions.get("d1")!.deliveryState, "delivering");
		assert.equal(store.rows.get("r1")!.state, "sent");
	});
});
