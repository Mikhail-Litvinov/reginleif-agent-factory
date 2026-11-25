// The documented recovery, end to end (docs/agent-factory/recovery.md): a backup of a stack that holds tables, rows, a
// foreign key, a vector column and rights for every account is restored into a NEW project beside the old one, and every
// account can do there what it could do before. Also: the restore refuses a database that already holds data, and the old
// stack is never touched.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { backup, type BackupResult } from "../deploy/backup/backup.ts";
import { restore } from "../deploy/backup/restore.ts";
import { freePort, findContainer, psql, tryPsql } from "../deploy/lib.ts";
import { Cleanups, createTestStack, trackedProject, type TestStack } from "./helpers.ts";

const ROLES = ["af_migrator", "af_api", "af_control", "af_backup", "af_reader"] as const;

// What each account tries; the answer of each statement is "ok:<output>" or "denied", so two servers can be compared.
const PROBES: Record<(typeof ROLES)[number], string[]> = {
	af_migrator: ["SELECT count(*) FROM parent;", "CREATE TABLE probe_m (id int); DROP TABLE probe_m;", "SELECT count(*) FROM pg_extension WHERE extname = 'vector';"],
	af_api: ["SELECT count(*) FROM parent;", "INSERT INTO parent VALUES (900, 'api'); DELETE FROM parent WHERE id = 900;", "SELECT count(*) FROM child;", "CREATE TABLE probe_a (id int);"],
	af_control: ["SELECT count(*) FROM child;", "SELECT count(*) FROM parent;", "UPDATE child SET parent_id = parent_id WHERE id = 1;"],
	af_backup: ["SELECT count(*) FROM parent;", "SELECT count(*) FROM items;", "INSERT INTO parent VALUES (901, 'x');"],
	af_reader: ["SELECT count(*) FROM parent;", "SELECT count(*) FROM child;", "SET default_transaction_read_only = off; INSERT INTO parent VALUES (902, 'x');"],
};

const behaviour = async (container: string): Promise<Record<string, string[]>> => {
	const result: Record<string, string[]> = {};
	for (const role of ROLES) {
		result[role] = [];
		for (const sql of PROBES[role]) {
			const answer = await tryPsql(container, role, sql);
			result[role].push(answer.code === 0 ? `ok:${answer.stdout.trim()}` : "denied");
		}
	}
	return result;
};

describe("recovery into a new project", () => {
	let old: TestStack;
	let work: string;
	let backupResult: BackupResult;
	let before_: Record<string, string[]>;
	let newProject = "";
	let newPort = 0;
	const cleanups = new Cleanups();

	before(async () => {
		cleanups.add(async () => {
			if (work) await rm(work, { recursive: true, force: true });
		});
		work = await mkdtemp(join(tmpdir(), "af-test-recovery-"));
		old = await createTestStack();
		const c = old.container;
		await psql(c, "af_migrator", [
			"CREATE TABLE parent (id int PRIMARY KEY, name text);",
			"CREATE TABLE child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES parent (id));",
			"CREATE TABLE items (id int PRIMARY KEY, embedding vector(3));",
			"INSERT INTO parent SELECT g, 'p' || g FROM generate_series(1, 30) g;",
			"INSERT INTO child SELECT g, 1 + g % 30 FROM generate_series(1, 90) g;",
			"INSERT INTO items VALUES (1, '[1,2,3]'), (2, '[4,5,6]');",
			"GRANT SELECT, INSERT, DELETE ON parent TO af_api;",
			"GRANT SELECT ON child TO af_api, af_control;",
			"GRANT SELECT, UPDATE ON child TO af_control;",
			"GRANT SELECT ON parent TO af_control, af_reader;",
			"GRANT SELECT ON child TO af_reader;",
		].join("\n"));
		before_ = await behaviour(c);
		backupResult = await backup({ project: old.project, target: join(work, "backups") });
		// The new project is registered for removal before it exists (its name only; removal of nothing is a no-op).
		newPort = await freePort();
		newProject = trackedProject(cleanups, old.secretsDir, newPort);
	});
	after(async () => {
		await old?.dispose();
		await cleanups.runAll();
	});

	it("the old stack behaves as the probes expect (so the comparison below is meaningful)", () => {
		assert.deepEqual(before_.af_api, ["ok:30", "ok:", "ok:90", "denied"]);
		assert.deepEqual(before_.af_backup, ["ok:30", "ok:2", "denied"]);
		assert.deepEqual(before_.af_reader, ["ok:30", "ok:90", "denied"]);
		assert.equal(before_.af_migrator?.[2], "ok:1");
	});

	it("restores into a new project, verified, and every account behaves as before", async () => {
		const result = await restore({ manifestPath: backupResult.manifestPath, secretsDir: old.secretsDir, project: newProject, port: newPort });
		assert.deepEqual(result.problems, []);
		assert.equal(result.ok, true);
		const container = await findContainer(newProject);
		assert.notEqual(container, old.container);
		assert.deepEqual(await behaviour(container), before_);
		// Data, the vector column and the foreign key came across.
		assert.equal(await psql(container, "af_backup", "SELECT embedding <-> '[4,5,6]' FROM items WHERE id = 2;"), "0");
		const fk = await psql(container, "af_backup", "SELECT convalidated FROM pg_constraint WHERE contype = 'f';");
		assert.equal(fk, "t");
		const fkRefused = await tryPsql(container, "af_migrator", "INSERT INTO child VALUES (9999, 424242);");
		assert.notEqual(fkRefused.code, 0);
		assert.match(fkRefused.stderr, /foreign key/);
	});

	it("the old stack was not touched", async () => {
		assert.equal(await psql(old.container, "af_backup", "SELECT count(*) FROM parent;"), "30");
		assert.deepEqual(await behaviour(old.container), before_);
	});

	it("refuses a database that already holds data and changes nothing there", async () => {
		const container = await findContainer(newProject);
		const result = await restore({ manifestPath: backupResult.manifestPath, secretsDir: old.secretsDir, project: newProject, port: newPort });
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /refused: .*already holds \d+ object/);
		assert.equal(await psql(container, "af_backup", "SELECT count(*) FROM parent;"), "30");
		// The refusal also holds against the old, running stack itself.
		const onOld = await restore({ manifestPath: backupResult.manifestPath, secretsDir: old.secretsDir, project: old.project, port: old.port });
		assert.equal(onOld.ok, false);
		assert.match(onOld.problems.join("\n"), /refused/);
		assert.equal(await psql(old.container, "af_backup", "SELECT count(*) FROM parent;"), "30");
	});

	it("refuses a damaged backup before creating anything", async () => {
		const project = trackedProject(cleanups, old.secretsDir, 0);
		const result = await restore({ manifestPath: join(work, "backups", "missing.manifest.json"), secretsDir: old.secretsDir, project });
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /manifest missing/);
	});
});
