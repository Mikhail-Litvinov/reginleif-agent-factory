import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
const tables = ["devices", "device_sessions", "outbox_events", "confirmations", "task_decisions", "idempotency_keys", "task_revisions", "notifications", "conversations", "messages", "polls", "poll_answer_requests"] as const;

it("applies the third migration and creates its tables", async () => {
	const db = await bench;
	const applied = await migrate({ url: db.migratorUrl });
	assert.match(applied[2] ?? "", /^0003_.*\.sql$/);
	const sql = connectBench(db.migratorUrl);
	try {
		for (const table of tables) {
			const rows = await sql<{ present: boolean }[]>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`;
			assert.equal(rows[0]?.present, true, table);
		}
	} finally { await sql.end(); }
});

it("assigns each stream row the inserting transaction id", async () => {
	const db = await bench;
	const sql = connectBench(db.migratorUrl);
	try {
		const conversation = randomUUID();
		const noticeId = randomUUID(), messageId = randomUUID();
		await sql`INSERT INTO conversations (id) VALUES (${conversation})`;
		const committedXid = await sql.begin(async (tx) => {
			const xid = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
			await tx`INSERT INTO notifications (id) VALUES (${noticeId})`;
			await tx`INSERT INTO messages (id, conversation_id) VALUES (${messageId}, ${conversation})`;
			return xid[0]!.xid;
		});
		const notice = await sql<{ xid: string }[]>`SELECT commit_xid::text AS xid FROM notifications WHERE id = ${noticeId}`;
		const message = await sql<{ xid: string }[]>`SELECT commit_xid::text AS xid FROM messages WHERE id = ${messageId}`;
		assert.equal(notice[0]?.xid, committedXid);
		assert.equal(message[0]?.xid, committedXid);
	} finally { await sql.end(); }
});

it("enforces the deferred outbox and decision references", async () => {
	const db = await bench;
	const sql = connectBench(db.migratorUrl);
	const actor = randomUUID(), outbox = randomUUID(), decision = randomUUID();
	try {
		await sql`INSERT INTO owners (id) VALUES (${actor})`;
		await sql.begin(async (tx) => {
			await tx`INSERT INTO outbox_events (id, decision_id) VALUES (${outbox}, ${decision})`;
			await tx`INSERT INTO task_decisions (id, actor_id, outbox_id) VALUES (${decision}, ${actor}, ${outbox})`;
		});
		const reverseOutbox = randomUUID(), reverseDecision = randomUUID();
		await assert.rejects(sql.begin(async (tx) => {
			await tx`INSERT INTO task_decisions (id, actor_id, outbox_id) VALUES (${reverseDecision}, ${actor}, ${reverseOutbox})`;
			await tx`INSERT INTO outbox_events (id, decision_id) VALUES (${reverseOutbox}, ${reverseDecision})`;
		}), /foreign key/i);
		await assert.rejects(sql.begin(async (tx) => {
			await tx`INSERT INTO outbox_events (id, decision_id) VALUES (${randomUUID()}, ${randomUUID()})`;
		}), /foreign key|pair/i);
		await assert.rejects(sql.begin(async (tx) => {
			await tx`INSERT INTO task_decisions (id, actor_id, outbox_id) VALUES (${randomUUID()}, ${actor}, ${randomUUID()})`;
		}), /foreign key|pair/i);
		await assert.rejects(sql.begin(async (tx) => {
			const mismatchOutbox = randomUUID(), mismatchDecision = randomUUID();
			await tx`INSERT INTO outbox_events (id) VALUES (${mismatchOutbox})`;
			await tx`INSERT INTO task_decisions (id, actor_id, outbox_id) VALUES (${mismatchDecision}, ${actor}, ${mismatchOutbox})`;
		}), /pair/i);
		await assert.rejects(sql`UPDATE task_decisions SET actor_id = NULL WHERE id = ${decision}`, /immutable/i);
		await assert.rejects(sql`DELETE FROM task_decisions WHERE id = ${decision}`, /immutable|forbidden/i);
	} finally { await sql.end(); }
});

it("protects immutable content and permits set-once fields", async () => {
	const db = await bench;
	const sql = connectBench(db.migratorUrl);
	const device = randomUUID(), session = randomUUID(), expiredDevice = randomUUID(), conversation = randomUUID(), message = randomUUID(), poll = randomUUID(), request = randomUUID(), confirmation = randomUUID(), revision = randomUUID();
	try {
		await sql`INSERT INTO devices (id, name, code_expires_at) VALUES (${device}, 'phone', 'infinity')`;
		await sql`INSERT INTO devices (id, code_expires_at) VALUES (${expiredDevice}, '-infinity')`;
		await assert.rejects(sql`UPDATE devices SET code_used_at = now() WHERE id = ${expiredDevice}`, /expired/i);
		await sql`INSERT INTO device_sessions (id, device_id) VALUES (${session}, ${device})`;
		await sql`UPDATE devices SET code_used_at = now() WHERE id = ${device}`;
		await assert.rejects(sql`UPDATE devices SET code_used_at = NULL WHERE id = ${device}`, /change twice/i);
		await assert.rejects(sql`UPDATE devices SET name = 'other' WHERE id = ${device}`, /immutable/i);
		await sql`UPDATE devices SET revoked_at = now() WHERE id = ${device}`;
		const sessions = await sql<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM device_sessions WHERE id = ${session}`;
		assert.equal(sessions[0]?.revoked, true);
		await assert.rejects(sql`INSERT INTO device_sessions (id, device_id) VALUES (${randomUUID()}, ${device})`, /revoked/i);
		await sql`INSERT INTO confirmations (id, operation) VALUES (${confirmation}, 'cancel')`;
		await sql`UPDATE confirmations SET used_at = now() WHERE id = ${confirmation}`;
		await assert.rejects(sql`UPDATE confirmations SET used_at = NULL WHERE id = ${confirmation}`, /change twice/i);
		await assert.rejects(sql`UPDATE confirmations SET operation = 'pause' WHERE id = ${confirmation}`, /immutable/i);
		await sql`INSERT INTO task_revisions (id, change_reason) VALUES (${revision}, 'reason')`;
		await assert.rejects(sql`UPDATE task_revisions SET requirements = 'changed' WHERE id = ${revision}`, /immutable/i);
		await sql`INSERT INTO conversations (id) VALUES (${conversation})`;
		await sql`INSERT INTO messages (id, conversation_id) VALUES (${message}, ${conversation})`;
		await assert.rejects(sql`UPDATE messages SET body = 'changed' WHERE id = ${message}`, /immutable/i);
		await sql`INSERT INTO polls (id, arbiter, state) VALUES (${poll}, 'hub', 'open')`;
		await sql`UPDATE polls SET state = 'answered', answer_key = 'one' WHERE id = ${poll}`;
		await assert.rejects(sql`UPDATE polls SET answer_key = 'two' WHERE id = ${poll}`, /change twice/i);
		await assert.rejects(sql`UPDATE polls SET arbiter = 'api' WHERE id = ${poll}`, /immutable/i);
		const task = randomUUID(), apiPoll = randomUUID();
		await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
		await sql`INSERT INTO polls (id, task_id, arbiter) VALUES (${apiPoll}, ${task}, 'api')`;
		await assert.rejects(sql`INSERT INTO poll_answer_requests (id, poll_id, state) VALUES (${randomUUID()}, ${apiPoll}, 'pending')`, /hub poll/i);
		await assert.rejects(sql`INSERT INTO poll_answer_requests (id, poll_id, state) VALUES (${randomUUID()}, ${poll}, 'accepted')`, /pending/i);
		await sql`INSERT INTO poll_answer_requests (id, poll_id, answer_key, state) VALUES (${request}, ${poll}, 'one', 'pending')`;
		await sql`UPDATE poll_answer_requests SET state = 'accepted', decided_at = now() WHERE id = ${request}`;
		await assert.rejects(sql`UPDATE poll_answer_requests SET state = 'refused', refusal_reason = 'late' WHERE id = ${request}`, /immutable/i);
		await assert.rejects(sql`UPDATE poll_answer_requests SET answer_key = 'two' WHERE id = ${request}`, /immutable/i);
		for (const table of ['devices', 'confirmations', 'task_revisions', 'messages', 'polls', 'poll_answer_requests']) {
			await assert.rejects(sql.unsafe(`DELETE FROM ${table}`), /immutable/i, table);
		}
	} finally { await sql.end(); }
});

it("limits database accounts across each table group", async () => {
	const db = await bench;
	const admin = connectBench(db.migratorUrl);
	const clients = ["devices", "device_sessions", "conversations", "messages", "polls", "poll_answer_requests"] as const;
	const ordinary = ["outbox_events", "confirmations", "task_decisions", "idempotency_keys", "task_revisions", "notifications"] as const;
	try {
		for (const [role, url] of [["af_api", db.apiUrl], ["af_control", db.controlUrl], ["af_backup", db.backupUrl]] as const) {
			const connection = connectBench(url);
			try {
				for (const table of [...clients, ...ordinary]) {
					await connection.unsafe(`SELECT * FROM ${table} LIMIT 1`);
					await assert.rejects(connection.unsafe(`DELETE FROM ${table}`), /permission denied/i, `${role} ${table}`);
					const grant = await admin<{ allowed: boolean }[]>`SELECT has_table_privilege(${role}, ${table}, 'INSERT') AS allowed`;
					assert.equal(grant[0]?.allowed, role !== 'af_backup' && !(role === 'af_control' && clients.includes(table as typeof clients[number])), `${role} ${table}`);
				}
				if (role === 'af_api') {
					await connection`INSERT INTO devices (id) VALUES (${randomUUID()})`;
					await assert.rejects(connection`UPDATE devices SET name = 'bad'`, /permission denied/i);
					await assert.rejects(connection`UPDATE outbox_events SET lease_owner = 'bad'`, /permission denied/i);
					await connection`INSERT INTO task_revisions (id, change_reason) VALUES (${randomUUID()}, 'reason')`;
					await assert.rejects(connection`UPDATE task_revisions SET requirements = 'bad'`, /permission denied/i);
				} else if (role === 'af_control') {
					await connection`INSERT INTO outbox_events (id) VALUES (${randomUUID()})`;
					await connection`UPDATE outbox_events SET lease_owner = 'control'`;
					await assert.rejects(connection`INSERT INTO devices (id) VALUES (${randomUUID()})`, /permission denied/i);
					await assert.rejects(connection`UPDATE task_revisions SET requirements = 'bad'`, /permission denied/i);
				} else {
					await assert.rejects(connection`INSERT INTO outbox_events (id) VALUES (${randomUUID()})`, /permission denied/i);
					await assert.rejects(connection`INSERT INTO devices (id) VALUES (${randomUUID()})`, /permission denied/i);
				}
			} finally { await connection.end(); }
		}
		for (const table of [...clients, ...ordinary]) {
			const reader = await admin<{ allowed: boolean }[]>`SELECT has_table_privilege('af_reader', ${table}, 'SELECT') AS allowed`;
			assert.equal(reader[0]?.allowed, false, table);
		}
	} finally { await admin.end(); }
});
