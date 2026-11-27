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

test("two projects and the global scope importing the same path and text each get their own record", async t => {
	const directory = await ownedTempDir(t, "registry-import-owners-");
	const memory = path.join(directory, "memory.md");
	await writeFile(memory, "# Shared\n\nSame section text in every project.\n", "utf8");
	const projectA = "70000000-0000-4000-8000-0000000000a1";
	const projectB = "70000000-0000-4000-8000-0000000000b1";
	await repo.projects.create({ id: projectA, name: "registry-import-owner-a", workspacePolicy: "worktree" });
	await repo.projects.create({ id: projectB, name: "registry-import-owner-b", workspacePolicy: "worktree" });
	const a = await importRegistryDrafts(repo, [{ path: memory, rootPath: directory, projectId: projectA }]);
	const b = await importRegistryDrafts(repo, [{ path: memory, rootPath: directory, projectId: projectB }]);
	assert.equal(a.added, 1);
	assert.equal(b.added, 1);
	assert.equal(b.records[0]!.projectId, projectB);
	assert.notEqual(a.records[0]!.id, b.records[0]!.id);
	const again = await importRegistryDrafts(repo, [{ path: memory, rootPath: directory, projectId: projectB }]);
	assert.equal(again.added, 0);
	assert.equal(again.records[0]!.id, b.records[0]!.id);
	// Repo level: an id held by another owner is refused, not returned as a hit.
	const { id, kind, authority, status, scopeType, problem, decision, reuse, source, sourceRef, createdBy } = a.records[0]!;
	await assert.rejects(repo.registry.records.createImportedIfAbsent({ id, kind, authority, status, scopeType, problem, decision, reuse, source, sourceRef, createdBy, projectId: projectB }), /import_identity_mismatch/);
});
