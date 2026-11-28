// Outbox relay against a real PostgreSQL (SKIP LOCKED leases, lease_until on the database clock) with a fake WorkflowClient.
// A crashed relay is simulated by a delivery that never returns and a lease pushed into the past with admin SQL: no sleeps.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { createOutboxRelay, type RelayTimers } from "../control/outbox-relay.ts";
import type { WorkflowClient } from "../control/workflow-client.ts";
import { migrate } from "../db/migrate.ts";
import { createRepo, type Repo } from "../db/repo/index.ts";
import { connectBench, databaseBench } from "./database-bench.ts";
import { fakeTemporal } from "./outbox-relay-fakes.ts";

const benchPromise = databaseBench(import.meta.url);
const owner = randomUUID();
const noTimers: RelayTimers = { every: () => () => undefined, sleep: async () => undefined };

let admin: ReturnType<typeof connectBench>;
let adminRepo: Repo;
const relayConnections: ReturnType<typeof connectBench>[] = [];
let controlUrl = "";

// One relay connection per relay, as in production: two relay processes never share a connection.
const newRelayRepo = (): Repo => { const connection = connectBench(controlUrl); relayConnections.push(connection); return createRepo(drizzle(connection)); };

const seedTask = async (status = "CREATED", workflowRunId: string | null = null): Promise<string> => {
	const id = randomUUID();
	await admin`INSERT INTO tasks (id, depth, status, workflow_run_id) VALUES (${id}, 0, ${status}, ${workflowRunId})`;
	return id;
};
const seedRow = async (kind: string, taskId: string | null): Promise<string> => {
	const id = randomUUID();
	await admin`INSERT INTO outbox_events (id, kind, task_id, state, attempts) VALUES (${id}, ${kind}, ${taskId}, 'pending', 0)`;
	return id;
};
const seedDecision = async (taskId: string, kind = "pause"): Promise<{ decisionId: string; outboxId: string }> => {
	const decisionId = randomUUID();
	const outboxId = randomUUID();
	await adminRepo.transaction(async (tx) => {
		await tx.decisions.insertPair({
			decision: { id: decisionId, taskId, kind, actorId: owner, channel: "client", idempotencyKey: randomUUID(), requestHash: "test", deliveryState: "recorded", outboxId },
			outbox: { id: outboxId, kind: "deliver_decision", taskId, decisionId, payload: { decision_id: decisionId }, state: "pending", attempts: 0 },
		});
	});
	return { decisionId, outboxId };
};
const rowOf = async (id: string) => (await admin`SELECT state, attempts, lease_owner, lease_until, next_attempt_at, last_error FROM outbox_events WHERE id = ${id}`)[0]!;
const expireLease = async (id: string) => { await admin`UPDATE outbox_events SET lease_until = now() - interval '1 second' WHERE id = ${id}`; };
const decisionOf = async (id: string) => (await admin`SELECT delivery_state, refusal_reason, delivered_at, resolved_at FROM task_decisions WHERE id = ${id}`)[0]!;

before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	controlUrl = bench.controlUrl;
	admin = connectBench(bench.migratorUrl);
	adminRepo = createRepo(drizzle(admin));
	await admin`INSERT INTO owners (id, name) VALUES (${owner}, 'relay owner')`;
});
after(async () => {
	for (const connection of relayConnections) await connection.end();
	await admin?.end();
});

describe("outbox lease", () => {
	it("two relays never hold the same row: a leased row is skipped, an expired lease is taken over", async () => {
		const taskId = await seedTask("RUNNING");
		const ids = [await seedRow("wake", taskId), await seedRow("wake", taskId), await seedRow("wake", taskId), await seedRow("wake", taskId)];
		const a = newRelayRepo();
		const b = newRelayRepo();
		const first = await a.outbox.claim({ owner: "A", leaseSeconds: 60, limit: 2 });
		const second = await b.outbox.claim({ owner: "B", leaseSeconds: 60, limit: 10 });
		assert.deepEqual(first.map((r) => r.id), ids.slice(0, 2));
		assert.deepEqual(second.map((r) => r.id), ids.slice(2));
		assert.equal((await b.outbox.claim({ owner: "B", leaseSeconds: 60, limit: 10 })).length, 0);
		// B cannot extend or finish A's row.
		assert.equal(await b.outbox.extend(ids[0]!, "B", 60), false);
		assert.equal(await b.outbox.markSent(ids[0]!, "B"), false);
		// A's lease runs out: B takes the row over, and A, still alive, can no longer write it.
		await expireLease(ids[0]!);
		assert.equal(await a.outbox.extend(ids[0]!, "A", 60), false);
		const taken = await b.outbox.claim({ owner: "B", leaseSeconds: 60, limit: 10 });
		assert.deepEqual(taken.map((r) => r.id), [ids[0]]);
		assert.equal(taken[0]!.attempts, 2);
		assert.equal(await a.outbox.markSent(ids[0]!, "A"), false);
		assert.equal(await b.outbox.markSent(ids[0]!, "B"), true);
		assert.equal((await rowOf(ids[0]!)).state, "sent");
		assert.equal((await rowOf(ids[0]!)).lease_owner, null);
	});

	it("two relays pressing at once deliver each row exactly once", async () => {
		const taskId = await seedTask("RUNNING");
		const ids = new Set<string>();
		for (let i = 0; i < 8; i += 1) ids.add(await seedRow("wake", taskId));
		const temporal = fakeTemporal();
		const make = (name: string) => createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: name, timers: noTimers, batch: 3 });
		const [one, two] = [make("R1"), make("R2")];
		const results = await Promise.all([one.pressOnce(), two.pressOnce(), one.pressOnce(), two.pressOnce(), one.pressOnce(), two.pressOnce()]);
		const sent = results.flatMap((r) => r.rows.filter((row) => ids.has(row.id)));
		assert.equal(new Set(sent.map((r) => r.id)).size, sent.length, "a row was delivered by two presses");
		assert.equal(sent.length, 8);
		assert.ok(sent.every((r) => r.outcome === "sent"));
		assert.equal(temporal.log.filter((line) => line === `wake ${taskId}`).length, 8);
	});

	it("a failed delivery keeps the row pending with the error and retries it after the delay", async () => {
		const taskId = await seedTask("CREATED");
		const id = await seedRow("start_workflow", taskId);
		const temporal = fakeTemporal();
		temporal.failures.push(new Error("temporal down"));
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === id).map((r) => r.outcome), ["released"]);
		const released = await rowOf(id);
		assert.equal(released.state, "pending");
		assert.equal(released.lease_owner, null);
		assert.equal(released.attempts, 1);
		assert.match(released.last_error, /temporal down/);
		assert.ok(released.next_attempt_at, "a retry time is set");
		assert.equal((await relay.pressOnce()).rows.filter((r) => r.id === id).length, 0, "not due yet");
		await admin`UPDATE outbox_events SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`;
		assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === id).map((r) => r.outcome), ["sent"]);
		assert.equal((await rowOf(id)).attempts, 2);
	});
});

describe("relay guards and routing", () => {
	it("does not start a final task or one already started; starts a CREATED task once", async () => {
		const final = await seedTask("ACCEPTED");
		const started = await seedTask("RUNNING", "run-1");
		const fresh = await seedTask("CREATED");
		const rows = { final: await seedRow("start_workflow", final), started: await seedRow("start_workflow", started), fresh: await seedRow("start_workflow", fresh) };
		const temporal = fakeTemporal();
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		await relay.pressOnce();
		assert.deepEqual(temporal.log.filter((line) => line.startsWith("start ")), [`start ${fresh}`]);
		assert.equal((await rowOf(rows.final)).state, "done");
		assert.equal((await rowOf(rows.started)).state, "done");
		assert.equal((await rowOf(rows.fresh)).state, "sent");
	});

	it("refuses the decision of a closed task with task_closed and sends no Update", async () => {
		const taskId = await seedTask("CANCELLED");
		const { decisionId, outboxId } = await seedDecision(taskId);
		const temporal = fakeTemporal();
		await createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers }).pressOnce();
		const decision = await decisionOf(decisionId);
		assert.equal(decision.delivery_state, "refused");
		assert.equal(decision.refusal_reason, "task_closed");
		assert.ok(decision.resolved_at);
		assert.equal((await rowOf(outboxId)).state, "done");
		assert.deepEqual(temporal.log.filter((line) => line.includes(decisionId)), []);
	});

	it("routes by kind: Update, Signal, effect handlers, notify", async () => {
		const taskId = await seedTask("RUNNING");
		const { decisionId, outboxId } = await seedDecision(taskId, "pause");
		const wake = await seedRow("wake", taskId);
		const stop = await seedRow("stop_run", taskId);
		const cleanup = await seedRow("cleanup", taskId);
		const notify = await seedRow("notify", taskId);
		const temporal = fakeTemporal();
		const calls: string[] = [];
		const effects = { stopRun: async () => { calls.push("stop"); }, cleanup: async () => { calls.push("cleanup"); } };
		await createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, effects, owner: "R", timers: noTimers }).pressOnce();
		assert.deepEqual(temporal.log.filter((line) => line.endsWith(decisionId) || line === `wake ${taskId}`), [`update pause ${decisionId}`, `wake ${taskId}`]);
		assert.deepEqual(calls, ["stop", "cleanup"]);
		assert.equal((await decisionOf(decisionId)).delivery_state, "delivering");
		for (const [id, state] of [[outboxId, "sent"], [wake, "sent"], [stop, "sent"], [cleanup, "sent"], [notify, "done"]] as const) assert.equal((await rowOf(id)).state, state);
	});
});

describe("relay-press-once", () => {
	it("the same decision delivered twice has one effect: a relay lost after the Update, then a second relay", async () => {
		const taskId = await seedTask("RUNNING");
		const { decisionId, outboxId } = await seedDecision(taskId, "pause");
		const temporal = fakeTemporal();
		// Relay A delivers the Update (Temporal records it) and then never returns: the process died before mark-sent.
		let crash!: () => void;
		const dead = new Promise<void>((resolve) => { crash = resolve; });
		let delivered!: () => void;
		const afterUpdate = new Promise<void>((resolve) => { delivered = resolve; });
		const crashing: WorkflowClient = { ...temporal.client, sendDecision: async (...args) => { await temporal.client.sendDecision(...args); delivered(); await dead; return { ok: true }; } };
		const relayA = createOutboxRelay({ repo: newRelayRepo(), workflows: crashing, owner: "A", timers: noTimers });
		const pressA = relayA.pressOnce();
		await afterUpdate;
		assert.equal(temporal.updates.size, 1, "A delivered the Update");
		const mid = await rowOf(outboxId);
		assert.equal(mid.state, "pending");
		assert.equal(mid.lease_owner, "A");
		const deliveredAt = (await decisionOf(decisionId)).delivered_at;
		assert.ok(deliveredAt);

		// A's lease runs out; relay B takes the row over and delivers the same decision id again.
		await expireLease(outboxId);
		const relayB = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "B", timers: noTimers });
		const resultB = await relayB.pressOnce();
		assert.deepEqual(resultB.rows.filter((r) => r.id === outboxId).map((r) => r.outcome), ["sent"]);
		assert.deepEqual(temporal.log.filter((line) => line.includes(decisionId)), [`update pause ${decisionId}`, `update pause ${decisionId}`]);
		assert.equal(temporal.updates.size, 1, "the second delivery is one effect with the first");
		assert.equal((await rowOf(outboxId)).state, "sent");
		const after = await decisionOf(decisionId);
		assert.equal(after.delivery_state, "delivering");
		assert.deepEqual(after.delivered_at, deliveredAt, "the second delivery does not rewrite the decision row");

		// A wakes up late: its lease is gone, so it writes nothing.
		crash();
		assert.deepEqual((await pressA).rows.filter((r) => r.id === outboxId).map((r) => r.outcome), ["lost"]);
		const final = await rowOf(outboxId);
		assert.equal(final.state, "sent");
		assert.equal(final.lease_owner, null);
	});
});
