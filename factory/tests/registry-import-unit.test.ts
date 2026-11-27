import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importRegistryDrafts } from "../registry/import.ts";
import type { Repo } from "../db/repo/index.ts";

test("imports only supplied sections as named drafts and repeated runs add nothing", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "registry-import-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const factoryDoc = path.join(directory, "factory.md");
	const projectMemory = path.join(directory, "memory.md");
	const ignored = path.join(directory, "ignored.md");
	await writeFile(factoryDoc, "# Overview\n\nUnrelated prose must be ignored.\n\n## Decisions\n| # | Decision | Source |\n|---|---|---|\n| D1 | Keep imported knowledge in draft status. | Owner |\n| D2 | Retain the named source. | Call |\n", "utf8");
	await writeFile(projectMemory, "# Memory\n\nUse the project-specific workflow.\n\n## Details\nKeep the same draft.\n", "utf8");
	await writeFile(ignored, "# Unselected\n\nThis file must not be imported.\n", "utf8");

	const rows = new Map<string, any>();
	let added = 0;
	const repo = { registry: { records: {
		createImportedIfAbsent: async (record: any) => {
			const existing = rows.get(record.id);
			if (existing) return { record: existing, inserted: false };
			rows.set(record.id, record);
			added++;
			return { record, inserted: true };
		},
	} } } as unknown as Repo;
	const sources = [{ path: factoryDoc, rootPath: directory }, { path: projectMemory, rootPath: directory, projectId: "project-1" }];

	const first = await importRegistryDrafts(repo, sources);
	assert.equal(first.added, 4);
	assert.equal(rows.size, 4);
	assert.ok([...rows.values()].every(row => row.status === "draft"));
	assert.ok([...rows.values()].every(row => row.source === "import"));
	assert.ok([...rows.values()].some(row => row.sourceRef.includes(factoryDoc) && row.problem === "D1" && row.sourceRef.includes("L8-L8") && row.authority === "owner"));
	assert.ok([...rows.values()].some(row => row.sourceRef.includes(factoryDoc) && row.problem === "D2" && row.sourceRef.includes("L9-L9") && row.authority === "agent"));
	const memoryRecords = [...rows.values()].filter(row => row.sourceRef.includes(projectMemory) && row.projectId === "project-1");
	assert.equal(memoryRecords.length, 2);
	assert.ok(memoryRecords.every(row => row.authority === "agent"));
	assert.ok(![...rows.values()].some(row => row.decision.includes("Unrelated prose")));

	await writeFile(projectMemory, "# Memory\n\nUse the project-specific workflow.\n\n\n## Details\nKeep the same draft.\n", "utf8");
	const second = await importRegistryDrafts(repo, sources);
	assert.equal(second.added, 0);
	assert.equal(added, 4);
});

test("the same source-relative paths keep their IDs across checkout roots", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "registry-import-roots-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const firstRoot = path.join(directory, "checkout-a");
	const secondRoot = path.join(directory, "checkout-b");
	const firstProjectRoot = path.join(firstRoot, "projects", "project-1");
	const secondProjectRoot = path.join(secondRoot, "projects", "project-1");
	const firstFactoryDoc = path.join(firstRoot, "docs", "architecture.md");
	const secondFactoryDoc = path.join(secondRoot, "docs", "architecture.md");
	const firstMemory = path.join(firstProjectRoot, "memory.md");
	const secondMemory = path.join(secondProjectRoot, "memory.md");
	for (const file of [firstFactoryDoc, secondFactoryDoc, firstMemory, secondMemory]) await mkdir(path.dirname(file), { recursive: true });
	const factoryText = "| # | Decision | Source |\n|---|---|---|\n| D1 | Preserve this decision. | Owner |\n";
	const memoryText = "# Memory\n\nPreserve this project memory.\n";
	await Promise.all([writeFile(firstFactoryDoc, factoryText), writeFile(secondFactoryDoc, factoryText), writeFile(firstMemory, memoryText), writeFile(secondMemory, memoryText)]);
	const rows = new Map<string, any>();
	let added = 0;
	const repo = { registry: { records: { createImportedIfAbsent: async (record: any) => {
		const existing = rows.get(record.id);
		if (existing) return { record: existing, inserted: false };
		rows.set(record.id, record);
		added++;
		return { record, inserted: true };
	} } } } as unknown as Repo;
	const firstSources = [{ path: firstFactoryDoc, rootPath: firstRoot }, { path: firstMemory, rootPath: firstProjectRoot, projectId: "project-1" }];
	const secondSources = [{ path: secondFactoryDoc, rootPath: secondRoot }, { path: secondMemory, rootPath: secondProjectRoot, projectId: "project-1" }];
	assert.equal((await importRegistryDrafts(repo, firstSources)).added, 2);
	assert.equal((await importRegistryDrafts(repo, secondSources)).added, 0);
	assert.equal(added, 2);
});

test("Factory decision authority follows the table Source column", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "registry-import-authority-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, "decisions.md");
	await writeFile(source, "| # | Decision | Source |\n|---|---|---|\n| D1 | Owner decision. | Owner |\n| D2 | Non-owner decision. | Call |\n", "utf8");
	const rows = new Map<string, any>();
	const repo = { registry: { records: { createImportedIfAbsent: async (record: any) => {
		const existing = rows.get(record.id);
		if (existing) return { record: existing, inserted: false };
		rows.set(record.id, record);
		return { record, inserted: true };
	} } } } as unknown as Repo;
	await importRegistryDrafts(repo, [{ path: source, rootPath: directory }]);
	assert.equal([...rows.values()].find(row => row.problem === "D1")?.authority, "owner");
	assert.equal([...rows.values()].find(row => row.problem === "D2")?.authority, "agent");
});

test("project memory sections use agent authority", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "registry-import-memory-authority-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, "memory.md");
	await writeFile(source, "# Memory\n\nProject memory text.\n", "utf8");
	let inserted: any;
	const repo = { registry: { records: { createImportedIfAbsent: async (record: any) => {
		inserted = record;
		return { record, inserted: true };
	} } } } as unknown as Repo;
	await importRegistryDrafts(repo, [{ path: source, rootPath: directory, projectId: "project-memory-authority" }]);
	assert.equal(inserted.authority, "agent");
	assert.equal(inserted.createdBy.type, "agent");
});

test("preserves non-ASCII fixture text while source code stays ASCII", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "registry-import-unicode-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = path.join(directory, "memory.md");
	await writeFile(source, `# Note\n\n\u041f\u0430\u043c\u044f\u0442\u044c.\n`, "utf8");
	let inserted: any;
	const repo = { registry: { records: { createImportedIfAbsent: async (row: any) => { inserted = row; return { record: row, inserted: true }; } } } } as unknown as Repo;
	await importRegistryDrafts(repo, [{ path: source, rootPath: directory, projectId: "project-unicode" }]);
	assert.match(inserted.decision, /\u041f\u0430\u043c\u044f\u0442\u044c/u);
});
