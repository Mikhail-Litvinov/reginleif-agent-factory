import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../../db/migrate.ts";
import { createRepo } from "../../db/repo/index.ts";
import { importRegistryDrafts } from "../../registry/import.ts";
import { connectBench, databaseBench } from "../database-bench.ts";
import { ownedTempDir } from "../owned-temp.ts";

const benchPromise = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;

before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	client = connectBench(bench.migratorUrl);
	repo = createRepo(drizzle(client));
});
after(async () => { await client?.end(); });

test("Factory documents and project memories import as source-named drafts once", async t => {
	const directory = await ownedTempDir(t, "registry-import-bench-");
	const factoryDocument = path.join(directory, "factory.md");
	const projectRoot = path.join(directory, "project");
	const projectMemory = path.join(projectRoot, "memory.md");
	await mkdir(projectRoot, { recursive: true });
	await writeFile(factoryDocument, "# Intro\n\nIgnore this prose.\n\n| # | Decision | Source |\n|---|---|---|\n| D1 | Keep imported knowledge in draft status. | Owner |\n", "utf8");
	await writeFile(projectMemory, "# Project memory\n\nUse the project build workflow.\n", "utf8");
	const projectId = "70000000-0000-4000-8000-000000000001";
	await repo.projects.create({ id: projectId, name: "registry-import-bench", workspacePolicy: "worktree" });
	const sources = [{ path: factoryDocument, rootPath: directory }, { path: projectMemory, rootPath: projectRoot, projectId }];

	const first = await importRegistryDrafts(repo, sources);
	assert.equal(first.added, 2);
	assert.ok(first.records.every(record => record.status === "draft" && record.source === "import" && record.sourceRef));
	assert.ok(first.records.some(record => record.sourceRef?.includes(factoryDocument)));
	assert.ok(first.records.some(record => record.sourceRef?.includes(projectMemory) && record.projectId === projectId));

	const second = await importRegistryDrafts(repo, sources);
	assert.equal(second.added, 0);
	assert.deepEqual(second.records.map(record => record.id), first.records.map(record => record.id));
});
