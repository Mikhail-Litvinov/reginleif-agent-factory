// Outbox relay against a real PostgreSQL (SKIP LOCKED leases, lease_until on the database clock) with a fake WorkflowClient.
// A crashed relay is simulated by a delivery that never returns and a lease pushed into the past with admin SQL: no sleeps.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { createOutboxRelay, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_MAX_SECONDS, DEFAULT_RETRY_SECONDS, retryDelaySeconds, type RelayTimers } from "../control/outbox-relay.ts";
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
const seedRow = async (kind: string, taskId: string | null, payload: Record<string, unknown> | null = null): Promise<string> => {
	const id = randomUUID();
	await admin`INSERT INTO outbox_events (id, kind, task_id, state, attempts, payload) VALUES (${id}, ${kind}, ${taskId}, 'pending', 0, ${payload === null ? null : JSON.stringify(payload)}::jsonb)`;
	return id;
};
const notificationsOf = async (dedupKey: string) => Array.from(await admin`SELECT event_type, state, occurrences, task_id FROM notifications WHERE dedup_key = ${dedupKey}`);
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
		// One row per task: rows of one task are claimed one at a time (see "per-task delivery order" below).
		const ids = [await seedRow("wake", await seedTask("RUNNING")), await seedRow("wake", await seedTask("RUNNING")), await seedRow("wake", await seedTask("RUNNING")), await seedRow("wake", await seedTask("RUNNING"))];
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
		const tasks = new Map<string, string>();
		for (let i = 0; i < 8; i += 1) { const taskId = await seedTask("RUNNING"); tasks.set(await seedRow("wake", taskId), taskId); }
		const ids = new Set(tasks.keys());
		const temporal = fakeTemporal();
		const make = (name: string) => createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: name, timers: noTimers, batch: 3 });
		const [one, two] = [make("R1"), make("R2")];
		const results = await Promise.all([one.pressOnce(), two.pressOnce(), one.pressOnce(), two.pressOnce(), one.pressOnce(), two.pressOnce()]);
		const sent = results.flatMap((r) => r.rows.filter((row) => ids.has(row.id)));
		assert.equal(new Set(sent.map((r) => r.id)).size, sent.length, "a row was delivered by two presses");
		assert.equal(sent.length, 8);
		assert.ok(sent.every((r) => r.outcome === "done"), "a wake is final once the Signal is sent");
		for (const taskId of tasks.values()) assert.equal(temporal.log.filter((line) => line === `wake ${taskId}`).length, 1);
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

// temporal.md "Delivery order": a row is claimable only when no older row of its task is still `pending` (leased or not) or `failed`.
describe("per-task delivery order", () => {
	it("a row waits for the older rows of its task, whoever holds them", async () => {
		const taskId = await seedTask("RUNNING");
		const [a1, a2, a3] = [await seedRow("wake", taskId), await seedRow("wake", taskId), await seedRow("wake", taskId)];
		const own = new Set([a1, a2, a3]);
		const a = newRelayRepo();
		const b = newRelayRepo();
		const claimed = async (repo: Repo, name: string) => (await repo.outbox.claim({ owner: name, leaseSeconds: 60, limit: 50 })).map((r) => r.id!).filter((id) => own.has(id));
		assert.deepEqual(await claimed(a, "A"), [a1], "one row of the task per claim");
		assert.deepEqual(await claimed(b, "B"), [], "A holds a1: B must not take a2");
		// A's delivery fails and the row waits for its retry time: the later rows still wait.
		assert.equal(await a.outbox.release(a1, "A", "temporal down", 30), true);
		assert.deepEqual(await claimed(b, "B"), [], "a1 is pending, not due: a2 stays behind it");
		await admin`UPDATE outbox_events SET next_attempt_at = now() - interval '1 second' WHERE id = ${a1}`;
		assert.deepEqual(await claimed(b, "B"), [a1]);
		// Once a1 is sent, a2 is next; a3 still waits for a2.
		assert.equal(await b.outbox.markSent(a1, "B"), true);
		assert.deepEqual(await claimed(a, "A"), [a2]);
		assert.equal(await a.outbox.markDone(a2, "A"), true);
		assert.deepEqual(await claimed(b, "B"), [a3]);
	});

	it("two relays with interleaved rows of one task deliver them in insertion order", async () => {
		const taskId = await seedTask("RUNNING");
		const ids = [await seedRow("stop_run", taskId, { n: 1 }), await seedRow("stop_run", taskId, { n: 2 }), await seedRow("stop_run", taskId, { n: 3 })];
		const own = new Set(ids);
		const order: number[] = [];
		let open!: () => void;
		const gate = new Promise<void>((resolve) => { open = resolve; });
		let entered!: () => void;
		const inside = new Promise<void>((resolve) => { entered = resolve; });
		const record = (payload: Record<string, unknown>) => { if (payload.taskId === taskId) order.push(payload.n as number); };
		const slow = { stopRun: async (payload: Record<string, unknown>) => { if (payload.taskId === taskId && payload.n === 1) { entered(); await gate; } record(payload); }, cleanup: async () => undefined };
		const quick = { stopRun: async (payload: Record<string, unknown>) => { record(payload); }, cleanup: async () => undefined };
		const temporal = fakeTemporal();
		const relayA = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, effects: slow, owner: "A", timers: noTimers });
		const relayB = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, effects: quick, owner: "B", timers: noTimers });
		const pressA = relayA.pressOnce();
		await inside;
		// A is in the middle of row 1. B runs rounds meanwhile and must find nothing of this task.
		for (let round = 0; round < 3; round += 1) assert.deepEqual((await relayB.pressOnce()).rows.filter((r) => own.has(r.id)), []);
		open();
		assert.deepEqual((await pressA).rows.filter((r) => own.has(r.id)).map((r) => r.id), [ids[0]]);
		for (let round = 0; round < 3; round += 1) await relayB.pressOnce();
		assert.deepEqual(order, [1, 2, 3]);
	});

	it("a failed row blocks the later rows of its task until the owner acts; other tasks go on", async () => {
		const blockedTask = await seedTask("RUNNING");
		const otherTask = await seedTask("RUNNING");
		// A deliver_decision row without a decision can never be delivered: a permanent failure.
		const broken = await seedRow("deliver_decision", blockedTask);
		const behind = await seedRow("wake", blockedTask);
		const elsewhere = await seedRow("wake", otherTask);
		const own = new Set([broken, behind, elsewhere]);
		const temporal = fakeTemporal();
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		const first = (await relay.pressOnce()).rows.filter((r) => own.has(r.id));
		assert.deepEqual(first.map((r) => [r.id, r.outcome]).sort(), [[broken, "failed"], [elsewhere, "done"]].sort());
		for (let round = 0; round < 2; round += 1) assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === behind), [], "blocked behind the failed row");
		assert.equal((await rowOf(behind)).state, "pending");
		// The owner acts (here: closes the broken row); the next round delivers the row behind it.
		await admin`UPDATE outbox_events SET state = 'done', done_at = now() WHERE id = ${broken}`;
		assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === behind).map((r) => r.outcome), ["done"]);
	});
});

// temporal.md "Retry limit": attempts run out -> `failed` and one notification per row.
describe("retry limit", () => {
	it("a delivery that keeps failing ends failed after the last attempt with one notification, deduped across repeats", async () => {
		const taskId = await seedTask("CREATED");
		const id = await seedRow("start_workflow", taskId);
		const later = await seedRow("wake", taskId);
		const temporal = fakeTemporal();
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		const attempt = async () => {
			temporal.failures.push(new Error("temporal down"));
			await admin`UPDATE outbox_events SET next_attempt_at = NULL WHERE id = ${id}`;
			return (await relay.pressOnce()).rows.filter((r) => r.id === id).map((r) => r.outcome);
		};
		for (let n = 1; n < DEFAULT_MAX_ATTEMPTS; n += 1) {
			assert.deepEqual(await attempt(), ["released"], `attempt ${n} is retried`);
			assert.deepEqual(await notificationsOf(`outbox-failed:${id}`), [], "no notification before the limit");
		}
		assert.deepEqual(await attempt(), ["failed"], "the last attempt ends the row");
		const failed = await rowOf(id);
		assert.equal(failed.state, "failed");
		assert.equal(failed.attempts, DEFAULT_MAX_ATTEMPTS);
		assert.match(failed.last_error, /temporal down/);
		const notes = await notificationsOf(`outbox-failed:${id}`);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]!.event_type, "retry_limit_exceeded");
		assert.equal(notes[0]!.state, "open");
		assert.equal(notes[0]!.task_id, taskId);
		// The later row of the task waits behind the failed one.
		assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === later), []);
		// The owner puts the row back for another try; failing again does not raise a second notification.
		await admin`UPDATE outbox_events SET state = 'pending', next_attempt_at = NULL WHERE id = ${id}`;
		temporal.failures.push(new Error("temporal down"));
		assert.deepEqual((await relay.pressOnce()).rows.filter((r) => r.id === id).map((r) => r.outcome), ["failed"]);
		assert.equal((await notificationsOf(`outbox-failed:${id}`)).length, 1, "one open notification per row");
	});

	it("the retry delay grows with the attempt and stops at the cap", async () => {
		const taskId = await seedTask("CREATED");
		const id = await seedRow("start_workflow", taskId);
		const temporal = fakeTemporal();
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		const delays: number[] = [];
		for (let n = 1; n < DEFAULT_MAX_ATTEMPTS; n += 1) {
			temporal.failures.push(new Error("temporal down"));
			await admin`UPDATE outbox_events SET next_attempt_at = NULL WHERE id = ${id}`;
			await relay.pressOnce();
			delays.push(Number((await admin`SELECT extract(epoch FROM next_attempt_at - updated_at) AS s FROM outbox_events WHERE id = ${id}`)[0]!.s));
		}
		assert.deepEqual(delays.map(Math.round), Array.from({ length: DEFAULT_MAX_ATTEMPTS - 1 }, (_, i) => retryDelaySeconds(i + 1, { retrySeconds: DEFAULT_RETRY_SECONDS, retryMaxSeconds: DEFAULT_RETRY_MAX_SECONDS })));
		assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]!), "never shorter than the one before");
	});
});

// temporal.md "Sent and done": `sent` is closed to `done` once PostgreSQL shows the effect.
describe("sent sweep", () => {
	it("closes a start_workflow row once the task has run, and a deliver_decision row once the decision is resolved", async () => {
		const startTask = await seedTask("CREATED");
		const decisionTask = await seedTask("RUNNING");
		const start = await seedRow("start_workflow", startTask);
		const { decisionId, outboxId } = await seedDecision(decisionTask, "pause");
		const own = new Set([start, outboxId]);
		const temporal = fakeTemporal();
		const relay = createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, owner: "R", timers: noTimers });
		await relay.pressOnce();
		assert.equal((await rowOf(start)).state, "sent");
		assert.equal((await rowOf(outboxId)).state, "sent");
		// Nothing confirms them yet: the rows stay `sent` and are looked at again later, not delivered again.
		const waiting = await relay.pressOnce();
		assert.equal(waiting.rows.filter((r) => own.has(r.id)).length, 0);
		assert.equal(temporal.log.filter((line) => line === `start ${startTask}`).length, 1);
		assert.equal((await rowOf(start)).state, "sent");
		assert.ok((await rowOf(start)).next_attempt_at, "an unconfirmed row is rechecked after a delay, not on every round");
		// The workflow ran: PostgreSQL shows it.
		await admin`UPDATE tasks SET status = 'PLANNING', workflow_run_id = 'run-1' WHERE id = ${startTask}`; // CREATED -> PLANNING is a legal transition (states.ts)
		await admin`UPDATE task_decisions SET delivery_state = 'applied', resolved_at = now() WHERE id = ${decisionId}`;
		await admin`UPDATE outbox_events SET next_attempt_at = NULL WHERE id IN (${start}, ${outboxId})`;
		const closing = await relay.pressOnce();
		assert.ok(closing.confirmed >= 2);
		for (const id of own) { const row = await rowOf(id); assert.equal(row.state, "done"); }
		assert.ok((await admin`SELECT done_at FROM outbox_events WHERE id = ${start}`)[0]!.done_at, "done_at is stamped");
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
		// Each row has its own task: rows of one task go one per round.
		const taskId = await seedTask("RUNNING");
		const { decisionId, outboxId } = await seedDecision(taskId, "pause");
		const wakeTask = await seedTask("RUNNING");
		const wake = await seedRow("wake", wakeTask);
		const stop = await seedRow("stop_run", await seedTask("RUNNING"));
		const cleanup = await seedRow("cleanup", await seedTask("RUNNING"));
		const notify = await seedRow("notify", await seedTask("RUNNING"));
		const temporal = fakeTemporal();
		const calls: string[] = [];
		const effects = { stopRun: async () => { calls.push("stop"); }, cleanup: async () => { calls.push("cleanup"); } };
		await createOutboxRelay({ repo: newRelayRepo(), workflows: temporal.client, effects, owner: "R", timers: noTimers }).pressOnce();
		assert.deepEqual(temporal.log.filter((line) => line.endsWith(decisionId) || line === `wake ${wakeTask}`), [`update pause ${decisionId}`, `wake ${wakeTask}`]);
		assert.deepEqual(calls.filter((call, i) => calls.indexOf(call) === i), ["stop", "cleanup"]);
		assert.equal((await decisionOf(decisionId)).delivery_state, "delivering");
		// sent: the Update is confirmed later, from the decision row; wake, stop_run and cleanup need no confirmation.
		for (const [id, state] of [[outboxId, "sent"], [wake, "done"], [stop, "done"], [cleanup, "done"], [notify, "done"]] as const) assert.equal((await rowOf(id)).state, state);
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
