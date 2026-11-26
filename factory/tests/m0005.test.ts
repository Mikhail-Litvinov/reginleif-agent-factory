import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
it("applies migration 0005", async () => {
	const db = await bench;
	const applied = await migrate({ url: db.migratorUrl });
	assert.match(applied[4] ?? "", /^0005_.*\.sql$/);
});

it("requires an independent reviewer and protects review records", async () => {
	const db = await bench, sql = connectBench(db.migratorUrl);
	const task = randomUUID(), other = randomUUID(), author = randomUUID(), sameProvider = randomUUID(), reviewer = randomUUID();
	const implementation = randomUUID(), ownReview = randomUUID(), sameReview = randomUUID(), reviewRun = randomUUID(), review = randomUUID();
	try {
		await sql`INSERT INTO tasks (id, depth) VALUES (${task}, 0), (${other}, 0)`;
		await sql`INSERT INTO agents (id, provider) VALUES (${author}, 'provider-a'), (${sameProvider}, 'provider-a'), (${reviewer}, 'provider-b')`;
		await sql`INSERT INTO task_runs (id, task_id, agent_id, role) VALUES (${implementation}, ${task}, ${author}, 'implementer'), (${ownReview}, ${task}, ${author}, 'reviewer'), (${sameReview}, ${task}, ${sameProvider}, 'reviewer'), (${reviewRun}, ${task}, ${reviewer}, 'reviewer')`;
		await assert.rejects(sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id) VALUES (${randomUUID()}, ${task}, ${implementation}, ${author})`, /reviewer run/i);
		await assert.rejects(sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id) VALUES (${randomUUID()}, ${task}, ${ownReview}, ${author})`, /independent/i);
		await assert.rejects(sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id) VALUES (${randomUUID()}, ${task}, ${sameReview}, ${sameProvider})`, /independent/i);
		await assert.rejects(sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id) VALUES (${randomUUID()}, ${other}, ${reviewRun}, ${reviewer})`, /reviewer run/i);
		await sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id) VALUES (${review}, ${task}, ${reviewRun}, ${reviewer})`;
		await assert.rejects(sql`INSERT INTO task_reviews (id, task_id, run_id, reviewer_id, disputes_review_id) VALUES (${randomUUID()}, ${task}, ${reviewRun}, ${reviewer}, ${review})`, /fresh run/i);
		const outcome = randomUUID(), approval = randomUUID(), proposal = randomUUID();
		await sql`INSERT INTO review_finding_outcomes (id, review_id) VALUES (${outcome}, ${review})`;
		await sql`INSERT INTO task_approvals (id) VALUES (${approval})`;
		await sql`INSERT INTO task_proposals (id, title, state) VALUES (${proposal}, 'initial', 'open')`;
		await assert.rejects(sql`UPDATE task_reviews SET verdict = 'pass' WHERE id = ${review}`, /immutable/i);
		await assert.rejects(sql`DELETE FROM review_finding_outcomes WHERE id = ${outcome}`, /immutable/i);
		await assert.rejects(sql`DELETE FROM task_approvals WHERE id = ${approval}`, /immutable/i);
		await sql`UPDATE task_proposals SET state = 'accepted' WHERE id = ${proposal}`;
		await assert.rejects(sql`UPDATE task_proposals SET title = 'changed' WHERE id = ${proposal}`, /immutable/i);
	} finally { await sql.end(); }
});

it("grants review table rights by role", async () => {
	const db = await bench;
	for (const [role, url] of [["api", db.apiUrl], ["control", db.controlUrl], ["backup", db.backupUrl]] as const) {
		const sql = connectBench(url);
		try {
			for (const table of ["task_reviews", "review_finding_outcomes", "task_approvals", "task_proposals"]) {
				await sql.unsafe(`SELECT * FROM ${table} LIMIT 0`);
				await assert.rejects(sql.unsafe(`DELETE FROM ${table}`), /permission denied/i);
			}
			if (role === "backup") await assert.rejects(sql`INSERT INTO task_proposals (id) VALUES (${randomUUID()})`, /permission denied/i);
			else { await sql`INSERT INTO task_proposals (id) VALUES (${randomUUID()})`; await sql`UPDATE task_proposals SET state = 'open' WHERE false`; await assert.rejects(sql`UPDATE task_reviews SET verdict = 'pass'`, /permission denied/i); }
		} finally { await sql.end(); }
	}
});
