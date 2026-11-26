import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { OwnedDir } from "../deploy/owned.ts";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
const mutable = ["owners", "projects", "agents", "workers", "settings", "routing_rules", "api_tokens"] as const;
const immutable = ["execution_policies", "audit_log"] as const;
const tables = [...mutable, ...immutable];

it("applies 0001 and enforces its history, soft deletion and account rights", async () => {
	const db = await bench;
	const owned = await OwnedDir.make(tmpdir(), "af-m0001-");
	const dir = owned.path;
	try {
	await copyFile(fileURLToPath(new URL("../db/migrations/0001_core.sql", import.meta.url)), join(dir, "0001_core.sql"));
	await owned.files.adopt(join(dir, "0001_core.sql")); // copied by this test into its own directory
	const applied = await migrate({ url: db.migratorUrl, migrationsDir: dir });
	assert.equal(applied.length, 1);
	assert.match(applied[0]!, /^0001_.*\.sql$/);
	assert.deepEqual(await migrate({ url: db.migratorUrl, migrationsDir: dir }), []);
	const admin = connectBench(db.migratorUrl);
	try {
		const rows = await admin<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
		assert.deepEqual(rows.map((row) => row.table_name), ["af_migrations", ...tables].sort());
		await admin.unsafe(`
			INSERT INTO owners (id,name) VALUES ('00000000-0000-7000-8000-000000000001','owner');
			INSERT INTO projects (id,name,description,repository_url,default_branch,workspace_policy,settings,priority)
			VALUES ('00000000-0000-7000-8000-000000000002','project','description','repo','main','worktree','{}',1);
			INSERT INTO agents (id,name,provider,adapter_type,capabilities,enabled,concurrency_limit,configuration)
			VALUES ('00000000-0000-7000-8000-000000000003','agent','provider','adapter','{}',true,1,'{}');
			INSERT INTO workers (id,machine_id,name,platform,capabilities,version,contract_version,status,concurrency_limit)
			VALUES ('00000000-0000-7000-8000-000000000004','machine','worker','platform','{}','v1',1,'online',1);
			INSERT INTO settings (key,value,updated_by) VALUES ('key','1','00000000-0000-7000-8000-000000000001');
			INSERT INTO routing_rules (id,position,match,preferred_agent_ids) VALUES ('00000000-0000-7000-8000-000000000005',1,'{}','{}');
			INSERT INTO api_tokens (id,name,role,owner_id,prefix,token_hash,created_by) VALUES ('00000000-0000-7000-8000-000000000006','token','owner','00000000-0000-7000-8000-000000000001','prefix','hash','00000000-0000-7000-8000-000000000001');
			INSERT INTO execution_policies (id,version,allowed_commands,allowed_directories,allowed_repositories,network,git_operations,confirmation_required,allowed_tools,created_by)
			VALUES ('00000000-0000-7000-8000-000000000007',1,'{}','{}','{}','{}','{}','{}','{}','00000000-0000-7000-8000-000000000001');
			INSERT INTO audit_log (id,request_id,action,target_type,target_id,outcome,request_hash)
			VALUES ('00000000-0000-7000-8000-000000000008','00000000-0000-7000-8000-000000000009','action','project','00000000-0000-7000-8000-000000000002','ok','hash');
		`);
		for (const table of tables) await assert.rejects(admin.unsafe(`DELETE FROM ${table}`), /forbidden|immutable/i, table);
		await assert.rejects(admin`DELETE FROM routing_rules`, /forbidden/i);
		await admin`UPDATE routing_rules SET deleted_at = now()`;
		assert.ok((await admin<{ deleted_at: Date }[]>`SELECT deleted_at FROM routing_rules WHERE id = '00000000-0000-7000-8000-000000000005'`)[0]?.deleted_at instanceof Date);
		for (const table of immutable) await assert.rejects(admin.unsafe(`UPDATE ${table} SET id = id`), /immutable/i, table);
		await assert.rejects(admin`UPDATE projects SET deleted_at = now()`, /archived/i);
		await admin`UPDATE projects SET archived_at = now()`;
		await admin`CREATE TABLE tasks (project_id uuid NOT NULL, deleted_at timestamptz, origin_type text NOT NULL, status text NOT NULL)`;
		await admin`INSERT INTO tasks VALUES ('00000000-0000-7000-8000-000000000002', NULL, 'ordinary', 'RUNNING')`;
		await assert.rejects(admin`UPDATE projects SET deleted_at = now()`, /active tasks/i);
		await admin`UPDATE tasks SET status = 'ACCEPTED'`;
		await admin`INSERT INTO tasks VALUES ('00000000-0000-7000-8000-000000000002', NULL, 'standing', 'RUNNING')`;
		await admin`UPDATE projects SET deleted_at = now()`;
		await admin`DROP TABLE tasks`;
		await admin`UPDATE agents SET deleted_at = now()`;
		await admin`UPDATE agents SET capabilities = '[1,2]'::jsonb, configuration = 'true'::jsonb`;
		for (const [role, url] of [["af_api", db.apiUrl], ["af_control", db.controlUrl], ["af_backup", db.backupUrl]] as const) {
			const connection = connectBench(url);
			try {
				for (const table of tables) {
					await connection.unsafe(`SELECT * FROM ${table} LIMIT 1`);
					const insert = table === "settings" ? `INSERT INTO settings (key, value) VALUES ($1, '42'::jsonb)` : `INSERT INTO ${table} (id) VALUES ($1::uuid)`;
					const id = randomUUID();
					if (role === "af_backup") {
						await assert.rejects(connection.unsafe(insert, [id]), /permission denied/i, `${role} ${table} insert`);
					} else {
						await connection.unsafe(insert, [id]);
					}
					await assert.rejects(connection.unsafe(`DELETE FROM ${table}`), /permission denied/i, `${role} ${table}`);
					const update = table === "owners" ? "name = name" : table === "audit_log" || table === "execution_policies" ? "id = id" : "row_version = row_version";
					if (role === "af_backup" || immutable.includes(table as typeof immutable[number])) {
						await assert.rejects(connection.unsafe(`UPDATE ${table} SET ${update}`), /permission denied/i, `${role} ${table}`);
					} else {
						await connection.unsafe(`UPDATE ${table} SET ${update}`);
					}
					const privileges = await admin<{ ins: boolean; upd: boolean; del: boolean }[]>`SELECT has_table_privilege(${role}, ${table}, 'INSERT') AS ins, has_table_privilege(${role}, ${table}, 'UPDATE') AS upd, has_table_privilege(${role}, ${table}, 'DELETE') AS del`;
					assert.deepEqual({ ...privileges[0] }, { ins: role !== "af_backup", upd: role !== "af_backup" && !immutable.includes(table as typeof immutable[number]), del: false }, `${role} ${table}`);
				}
			} finally { await connection.end(); }
		}
	} finally { await admin.end(); }
	} finally { assert.deepEqual(await owned.remove(), []); }
});
