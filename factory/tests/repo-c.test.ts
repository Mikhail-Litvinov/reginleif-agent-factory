import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { databaseRefusal } from "../db/repo/errors.ts";
import { createRepo } from "../db/repo/index.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const benchPromise = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let repo: ReturnType<typeof createRepo>;
before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	client = connectBench(bench.migratorUrl);
	db = drizzle(client);
	repo = createRepo(db);
});
after(async () => { await client?.end(); });

// A horizon above everything this connection has committed. repo.audit.snapshotXmin() is cluster-wide, so while other
// test files hold open transactions in the shared cluster it can sit below rows committed here; these tests exercise
// the stream bounds, not the horizon source (production callers use snapshotXmin, covered by cursor.test.ts).
const horizonAboveCommitted = async (): Promise<string> =>
	String((await client`SELECT (pg_current_xact_id()::text::bigint + 1)::text AS horizon`)[0]!.horizon);

const id = (n: number) => `10000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("migration 0003 repositories", () => {
	it("writes a decision and its outbox row together and refuses an incomplete pair at commit", async () => {
		await db.insert((await import("../db/schema/owners.ts")).owners).values({ id: id(1), name: "repo-c-owner" });
		await db.insert((await import("../db/schema/tasks.ts")).tasks).values({ id: id(2), depth: 0 });
		const result = await repo.decisions.record({
			decision: { id: id(3), taskId: id(2), kind: "cancel", actorId: id(1), channel: "client", idempotencyKey: "cancel-1", requestHash: "hash", deliveryState: "recorded", outboxId: id(4) },
			outbox: { id: id(4), kind: "deliver_decision", taskId: id(2), decisionId: id(3), payload: { decision_id: id(3) }, state: "pending", attempts: 0 },
		});
		assert.equal(result.decision.id, id(3));
		assert.equal(result.outbox.decisionId, id(3));
		assert.equal((await repo.decisions.get(id(3)))?.id, id(3));
		assert.equal((await repo.decisions.byActorKey(id(1), "cancel-1"))?.id, id(3));
		assert.equal((await repo.decisions.listForTask(id(2))).length, 1);
		assert.equal((await repo.decisions.updateDelivery(id(3), { deliveryState: "applied", deliveredAt: new Date() }))?.deliveryState, "applied");
		// An engineer decision needs a chief_engineer run of its task (role exists since 0007): a run of another role is refused with the trigger's reason, a chief_engineer run is accepted.
		const { taskRuns } = await import("../db/schema/runs.ts");
		const { taskDecisions } = await import("../db/schema/decisions.ts");
		// database.md line 437: a chief_engineer run needs a right request naming its task as handler (or a BLOCKED task handled by the chief engineer).
		await client`INSERT INTO right_requests (id, task_id, handling_task_id, participant, action, target, conditions, request_hash) VALUES (${id(56)}, ${id(2)}, ${id(2)}, 'implementer', 'read', 'example', '{}'::jsonb, 'repo-c-request')`;
		await db.insert(taskRuns).values([
			{ id: id(54), taskId: id(2), attemptNumber: 1, role: "implementer", status: "created" },
			{ id: id(53), taskId: id(2), attemptNumber: 2, role: "chief_engineer", status: "created" },
		]);
		await assert.rejects(
			db.insert(taskDecisions).values({ id: id(55), taskId: id(2), kind: "physical_decision", engineerRunId: id(54), channel: "api", idempotencyKey: "engineer-0", deliveryState: "applied" }),
			(error) => databaseRefusal(error)?.reason === "engineer decision requires chief engineer run of task" && databaseRefusal(error)?.sqlstate === "P0001",
		);
		assert.equal(await repo.decisions.byEngineerKey(id(54), "engineer-0"), undefined);
		await db.insert(taskDecisions).values({ id: id(52), taskId: id(2), kind: "physical_decision", engineerRunId: id(53), channel: "api", idempotencyKey: "engineer-1", deliveryState: "applied" });
		assert.equal((await repo.decisions.byEngineerKey(id(53), "engineer-1"))?.id, id(52));
		assert.equal((await repo.outbox.get(id(4)))?.id, id(4));
		assert.equal((await repo.outbox.listPending()).some((row) => row.id === id(4)), true);
		await assert.rejects(db.transaction(async (tx) => {
			await tx.insert((await import("../db/schema/decisions.ts")).outboxEvents).values({ id: id(6), kind: "deliver_decision", taskId: id(2), state: "pending", attempts: 0 });
			await tx.insert((await import("../db/schema/decisions.ts")).taskDecisions).values({ id: id(5), taskId: id(2), kind: "pause", actorId: id(1), channel: "client", idempotencyKey: "pause-1", requestHash: "hash", deliveryState: "recorded", outboxId: id(6) });
		}), (error) => databaseRefusal(error)?.reason === "outbox decision pair does not match" && databaseRefusal(error)?.sqlstate === "P0001");
	});

	it("replays idempotency response data, and applies first poll answer only once", async () => {
		const key = { actorId: id(10), key: "operation-1", requestHash: "hash" };
		const first = await repo.transaction(async (tx) => {
			const claimed = await tx.idempotencyKeys.claim({ ...key, state: "in_progress" });
			assert.equal(claimed.replayed, false);
			await tx.idempotencyKeys.complete(id(10), "operation-1", 201, { id: id(11) });
			return tx.idempotencyKeys.get(id(10), "operation-1");
		});
		assert.equal(first?.state, "done");
		const replay = await repo.idempotencyKeys.claim({ ...key, state: "in_progress" });
		assert.equal(replay.replayed, true);
		assert.equal(replay.row.responseStatus, 201);
		assert.deepEqual(replay.row.responseBody, { id: id(11) });
		assert.equal((await repo.idempotencyKeys.get(id(10), "operation-1"))?.state, "done");

		await db.insert((await import("../db/schema/chat.ts")).conversations).values({ id: id(12), source: "factory", state: "active" });
		await repo.polls.create({ id: id(50), conversationId: id(12), sourceKey: "poll-key", options: [{ key: "yes", label: "Yes" }], arbiter: "hub", state: "open" });
		assert.equal((await repo.polls.create({ id: id(51), conversationId: id(12), sourceKey: "poll-key", options: [{ key: "yes", label: "Yes" }], arbiter: "hub", state: "open" })).id, id(50));
		assert.ok(await repo.polls.answer(id(50), { answerKey: "yes", answeredVia: "client", answeredSessionId: null }));
		assert.equal(await repo.polls.answer(id(50), { answerKey: "no", answeredVia: "telegram", answeredSessionId: null }), null);
		assert.equal((await repo.polls.get(id(50)))?.answerKey, "yes");
	});

	it("uses the committed transaction horizon and the supplied stream cursor bounds", async () => {
		await db.insert((await import("../db/schema/chat.ts")).conversations).values({ id: id(20), source: "factory", state: "active" });
		await repo.messages.append({ id: id(21), conversationId: id(20), kind: "text", author: "system", body: "stream-a" });
		await repo.messages.append({ id: id(22), conversationId: id(20), kind: "text", author: "system", body: "stream-b" });
		const below = await horizonAboveCommitted();
		const first = (await repo.messages.stream({ limit: 10, below })).find((row) => row.id === id(21));
		assert.ok(first);
		const later = await repo.messages.stream({ after: { commitXid: first.commitXid, seq: first.seq }, limit: 10, below });
		assert.equal(later.some((row) => row.id === id(21)), false);
		assert.equal(later.some((row) => row.id === id(22)), true);
	});

	it("covers device, confirmation, conversation, notification, and poll-request lifecycle methods", async () => {
		await db.insert((await import("../db/schema/owners.ts")).owners).values({ id: id(30), name: "client-owner" });
		const device = await repo.devices.create({ id: id(31), ownerId: id(30), name: "phone", platform: "android", codeHash: "code-hash", codeExpiresAt: new Date("2035-01-01T00:00:00Z") });
		assert.equal(device.id, id(31));
		assert.equal((await repo.devices.get(device.id))?.id, device.id);
		assert.equal((await repo.devices.list(id(30)))[0]?.id, device.id);
		assert.equal((await repo.devices.consumeCode("code-hash", new Date("2030-01-01T00:00:00Z")))?.codeUsedAt instanceof Date, true);
		const session = await repo.deviceSessions.create({ id: id(32), deviceId: id(31), prefix: "prefix", tokenHash: "token-hash", expiresAt: new Date("2035-01-01T00:00:00Z") });
		assert.equal(session.id, id(32));
		assert.equal((await repo.deviceSessions.byTokenHash("token-hash"))?.id, session.id);
		assert.equal((await repo.deviceSessions.touch(session.id))?.lastUsedAt instanceof Date, true);
		assert.equal((await repo.deviceSessions.list(id(31))).length, 1);
		assert.equal((await repo.deviceSessions.revoke(session.id))?.revokedAt instanceof Date, true);
		await repo.deviceSessions.create({ id: id(54), deviceId: id(31), prefix: "no-expiry", tokenHash: "no-expiry-hash" });
		assert.equal((await repo.deviceSessions.byTokenHash("no-expiry-hash"))?.id, id(54));
		assert.equal((await repo.devices.revoke(device.id))?.revokedAt instanceof Date, true);
		assert.equal((await repo.devices.list(id(30))).some((row) => row.id === device.id), true);

		const confirmation = await repo.confirmations.create({ id: id(33), actorId: id(30), channel: "client", operation: "cancel", targetType: "task", targetId: id(2), requestHash: "confirm-hash", nonceHash: "nonce-hash", expiresAt: new Date("2035-01-01T00:00:00Z") });
		assert.equal((await repo.confirmations.get(confirmation.id))?.id, confirmation.id);
		assert.ok(await repo.confirmations.consume({ id: confirmation.id, actorId: id(30), channel: "client", deviceSessionId: null, operation: "cancel", targetType: "task", targetId: id(2), requestHash: "confirm-hash", now: new Date("2030-01-01T00:00:00Z"), decisionId: id(3) }));
		assert.equal(await repo.confirmations.consume({ id: confirmation.id, actorId: id(30), channel: "client", deviceSessionId: null, operation: "cancel", targetType: "task", targetId: id(2), requestHash: "confirm-hash", now: new Date("2030-01-01T00:00:00Z"), decisionId: id(3) }), null);

		const convo = await repo.conversations.create({ id: id(34), source: "rig_session", sessionRef: "session-ref", state: "active", title: "Conversation" });
		assert.equal((await repo.conversations.list({ source: "rig_session" }))[0]?.id, convo.id);
		assert.equal((await repo.conversations.get(convo.id))?.id, convo.id);
		assert.equal((await repo.conversations.updateState(convo.id, "waiting"))?.state, "waiting");
		const message = await repo.messages.append({ id: id(38), conversationId: convo.id, sourceKey: "source-1", kind: "text", author: "owner", body: "hello", deviceSessionId: id(32) });
		assert.equal((await repo.messages.append({ id: id(40), conversationId: convo.id, sourceKey: "source-1", kind: "text", author: "owner", body: "duplicate", deviceSessionId: id(32) })).id, message.id);
		assert.equal((await repo.messages.get(message.id))?.id, message.id);
		assert.equal((await repo.messages.listForConversation(convo.id)).length, 1);
		assert.ok(await repo.notifications.create({ id: id(35), eventType: "task_blocked", dedupKey: "task:blocked", state: "open", occurrences: 1 }));
		assert.equal((await repo.notifications.list({ state: "open", eventType: "task_blocked" })).length, 1);
		assert.equal((await repo.notifications.stream({ limit: 10, below: await horizonAboveCommitted() })).some((row) => row.id === id(35)), true);
		assert.equal((await repo.notifications.markDelivered(id(35)))?.deliveredAt instanceof Date, true);

		await repo.polls.create({ id: id(13), conversationId: convo.id, options: [{ key: "yes", label: "Yes" }], arbiter: "hub", state: "open" });
		const request = await repo.pollAnswerRequests.create({ id: id(36), pollId: id(13), deviceSessionId: id(32), idempotencyKey: "answer-1", answerKey: "yes" });
		assert.equal((await repo.pollAnswerRequests.create({ id: id(37), pollId: id(13), deviceSessionId: id(32), idempotencyKey: "answer-1", answerKey: "yes" })).id, request.id);
		assert.equal((await repo.pollAnswerRequests.pending()).some((row) => row.id === request.id), true);
		assert.equal((await repo.pollAnswerRequests.markDelivered(request.id))?.deliveredAt instanceof Date, true);
		assert.equal((await repo.pollAnswerRequests.decide(request.id, { state: "refused", refusalReason: "poll_closed" }))?.state, "refused");
		assert.equal((await repo.pollAnswerRequests.decide(request.id, { state: "accepted" })), null);
		assert.equal((await repo.pollAnswerRequests.get(request.id))?.state, "refused");
		assert.equal((await repo.pollAnswerRequests.listForPoll(id(13), id(32))).length, 1);
		assert.equal((await repo.pollAnswerRequests.markDelivered(request.id)), null);
		await db.insert((await import("../db/schema/chat.ts")).polls).values({ id: id(39), conversationId: convo.id, options: [], arbiter: "hub", state: "open" });
		assert.equal((await repo.polls.list({ state: "open", arbiter: "hub" })).some((row) => row.id === id(39)), true);
		assert.equal((await repo.polls.expire(id(39)))?.state, "expired");
	});
});

it("repo queries use bound parameters and no string-built SQL", async () => {
	const directory = fileURLToPath(new URL("../db/repo/", import.meta.url));
	const files = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
	for (const name of files) {
		const source = await readFile(join(directory, name), "utf8");
		assert.doesNotMatch(source, /\bsql\s*\.\s*raw\b/, `${name} must not use sql.raw`);
		const untaggedTemplates = source.replace(/\bsql(?:<[^>]*>)?\s*`[^`]*`/gs, "");
		assert.doesNotMatch(untaggedTemplates, /`[^`]*\$\{/, `${name} must not interpolate into an untagged template string`);
		assert.doesNotMatch(source, /\.(?:execute|query|unsafe|where|having)\s*\([^)]*(?:\+\s*\w|\w\s*\+)/, `${name} must not concatenate values into a query`);
		assert.doesNotMatch(source, /(?:['"][^'"]*['"]\s*\+\s*[\w$]|[\w$]+\s*\+\s*['"][^'"]*['"])/, `${name} must not build strings by concatenation`);
	}
});
