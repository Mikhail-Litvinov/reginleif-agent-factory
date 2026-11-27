import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { StaleVersionError } from "../db/repo/errors.ts";
import { createRepo } from "../db/repo/index.ts";
import { owners } from "../db/schema/owners.ts";
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

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("migration 0001 repositories", () => {
	it("creates, reads, updates with row versions, and hides soft-deleted projects and agents", async () => {
		const project = await repo.projects.create({ id: id(1), name: "repo-project", workspacePolicy: "worktree" });
		assert.equal(project.rowVersion, 1n);
		assert.equal((await repo.projects.get(id(1)))?.name, "repo-project");
		assert.equal((await repo.projects.update(id(1), 1n, { description: "updated" }))?.rowVersion, 2n);
		await assert.rejects(repo.projects.update(id(1), 1n, { description: "stale" }), (error: unknown) =>
			error instanceof StaleVersionError && error.currentVersion === 2n);
		assert.equal((await repo.projects.archive(id(1), 2n))?.rowVersion, 3n);
		await assert.rejects(repo.projects.archive(id(1), 2n), (error: unknown) => error instanceof StaleVersionError && error.currentVersion === 3n);
		assert.equal(await repo.projects.update(id(999), 1n, { description: "missing" }), null);
		assert.equal(await repo.projects.archive(id(999), 1n), null);
		assert.equal((await repo.projects.list({ archived: true, q: "repo-proj" })).length, 1);
		assert.equal((await repo.projects.list()).some((row) => row.id === id(1)), true);

		await repo.agents.create({ id: id(2), name: "repo-agent", provider: "test", adapterType: "test", capabilities: [], enabled: true, concurrencyLimit: 1, configuration: {} });
		assert.equal((await repo.agents.get(id(2)))?.name, "repo-agent");
		assert.equal((await repo.agents.list({ provider: "test", enabled: true })).length, 1);
		assert.equal((await repo.agents.update(id(2), 1n, { enabled: false }))?.rowVersion, 2n);
		await assert.rejects(repo.agents.update(id(2), 1n, { enabled: true }), (error: unknown) =>
			error instanceof StaleVersionError && error.currentVersion === 2n);
		await assert.rejects(repo.agents.softDelete(id(2), 1n), (error: unknown) => error instanceof StaleVersionError && error.currentVersion === 2n);
		assert.equal((await repo.agents.softDelete(id(2), 2n))?.rowVersion, 3n);
		assert.equal(await repo.agents.update(id(999), 1n, { enabled: false }), null);
		assert.equal(await repo.agents.softDelete(id(999), 1n), null);
		assert.equal(await repo.agents.get(id(2)), undefined);
		assert.equal((await repo.agents.list({ includeDeleted: true })).some((row) => row.id === id(2)), true);
	});

	it("registers workers idempotently and applies optimistic updates", async () => {
		const input = { id: id(3), machineId: "machine-a", name: "worker", platform: "linux", capabilities: {}, version: "1", contractVersion: 1, status: "online", concurrencyLimit: 2 };
		// Registration updates the worker row the token was issued for; it never inserts one.
		assert.equal(await repo.workers.register(input), null);
		await client`INSERT INTO workers (id, name, platform, status, concurrency_limit) VALUES (${input.id}, 'worker', 'linux', 'online', 2)`;
		const first = (await repo.workers.register(input))!;
		const second = (await repo.workers.register({ ...input, name: "worker-renamed" }))!;
		assert.equal(first.id, second.id);
		assert.equal(second.name, "worker-renamed");
		assert.equal((await repo.workers.get(first.id))?.machineId, "machine-a");
		assert.equal((await repo.workers.list({ status: "online", platform: "linux" })).length, 1);
		assert.equal(second.rowVersion, first.rowVersion + 1n);
		assert.equal((await repo.workers.update(first.id, second.rowVersion, { status: "disabled" }))?.status, "disabled");
		await assert.rejects(repo.workers.update(first.id, second.rowVersion, { status: "online" }), (error: unknown) =>
			error instanceof StaleVersionError && error.currentVersion === second.rowVersion + 1n);
		assert.equal(await repo.workers.update(id(999), 1n, { status: "online" }), null);
	});

	it("snapshots named settings and writes settings with optimistic versions", async () => {
		await repo.settings.set("repo.setting", { value: 1 }, id(1));
		const snapshot = await repo.settings.snapshot(["repo.setting", "repo.missing"]);
		assert.deepEqual(snapshot, { "repo.setting": { value: 1 } });
		assert.equal((await repo.settings.set("repo.setting", { value: 2 }, id(1), 1n))?.rowVersion, 2n);
		await assert.rejects(repo.settings.set("repo.setting", { value: 3 }, id(1), 1n), (error: unknown) =>
			error instanceof StaleVersionError && error.currentVersion === 2n);
		assert.deepEqual(snapshot, { "repo.setting": { value: 1 } });
		assert.deepEqual(await repo.settings.snapshot(["repo.setting"]), { "repo.setting": { value: 2 } });
	});

	it("a settings write either takes effect or reports why it did not", async () => {
		const first = await repo.settings.set("repo.upsert", { value: 1 }, id(1));
		assert.equal(first.rowVersion, 1n);
		const second = await repo.settings.set("repo.upsert", { value: 2 }, id(1));
		assert.equal(second.rowVersion, 2n);
		assert.deepEqual(await repo.settings.snapshot(["repo.upsert"]), { "repo.upsert": { value: 2 } });
		await assert.rejects(repo.settings.set("repo.never-created", { value: 1 }, id(1), 1n), StaleVersionError);
		assert.deepEqual(await repo.settings.snapshot(["repo.never-created"]), {});
	});

	it("reads and appends immutable policy versions and routing rules", async () => {
		const policy = await repo.policies.create({ id: id(4), projectId: id(1), allowedCommands: ["node"], autoAcceptLowRisk: false });
		assert.equal(policy.version, 1);
		const next = await repo.policies.create({ id: id(5), projectId: id(1), allowedCommands: ["node", "git"], autoAcceptLowRisk: false });
		assert.equal(next.version, 2);
		assert.equal((await repo.policies.effective(id(1)))?.id, id(5));
		await repo.policies.create({ id: id(11), allowedCommands: ["node"], autoAcceptLowRisk: false });
		assert.equal((await repo.policies.effective(id(12)))?.id, id(11));
		const rule = await repo.routingRules.create({ id: id(6), projectId: id(1), position: 0, match: {}, preferredAgentIds: [id(2)] });
		assert.equal((await repo.routingRules.list(id(1)))[0]?.id, rule.id);
		assert.equal((await repo.routingRules.list(null)).length, 0);
		const deletedRule = await repo.routingRules.delete(rule.id);
		assert.equal(deletedRule?.id, rule.id);
		assert.ok(deletedRule?.deletedAt instanceof Date);
		assert.deepEqual(await repo.routingRules.list(id(1)), []);
		assert.deepEqual((await repo.routingRules.list(id(1), { includeDeleted: true })).map((row) => row.id), [rule.id]);
	});

	it("stores only token hashes, finds tokens by hash, rotates and revokes", async () => {
		await db.insert(owners).values({ id: id(7), name: "owner", telegramUserId: 123n });
		assert.equal((await repo.owners.byTelegramUserId(123n))?.id, id(7));
		const token = await repo.tokens.create({ id: id(8), name: "token", role: "owner", ownerId: id(7), prefix: "pfx", tokenHash: "sha256:hash", createdBy: id(7) });
		assert.equal(token.tokenHash, "sha256:hash");
		assert.equal((await repo.tokens.byHash("sha256:hash"))?.id, id(8));
		const rotated = await repo.tokens.rotate(id(8), 1n, { id: id(9), name: "replacement", role: "owner", ownerId: id(7), prefix: "pfx2", tokenHash: "sha256:next", createdBy: id(7) }, new Date("2030-01-01T00:00:00Z"));
		assert.equal(rotated?.replacesTokenId, id(8));
		assert.equal(await repo.tokens.rotate(id(999), 1n, { id: id(10), name: "missing", role: "owner", ownerId: id(7), prefix: "pfx3", tokenHash: "sha256:missing", createdBy: id(7) }, new Date("2030-01-01T00:00:00Z")), null);
		await assert.rejects(repo.tokens.rotate(id(8), 1n, { id: id(10), name: "unused", role: "owner", ownerId: id(7), prefix: "pfx3", tokenHash: "sha256:unused", createdBy: id(7) }, new Date("2030-01-01T00:00:00Z")), (error: unknown) =>
			error instanceof StaleVersionError && error.currentVersion === 2n);
		const listed = await repo.tokens.list();
		assert.equal(listed.length, 2);
		assert.equal("tokenHash" in listed[0]!, false);
		await assert.rejects(repo.tokens.revoke(id(9), 0n), (error: unknown) => error instanceof StaleVersionError && error.currentVersion === 1n);
		assert.equal((await repo.tokens.revoke(id(9), 1n))?.revokedAt instanceof Date, true);
		assert.equal(await repo.tokens.revoke(id(9), 1n), null);
		assert.equal(await repo.tokens.revoke(id(999), 1n), null);
	});

	it("appends and reads audit rows without an update surface", async () => {
		const row = await repo.audit.append({ id: id(10), actorId: id(7), action: "repo.test", targetType: "project", targetId: id(1), outcome: "ok", requestHash: "hash" });
		assert.equal(row.action, "repo.test");
		assert.equal((await repo.audit.list({ action: "repo.test", below: (BigInt(row.commitXid) + 1n).toString() })).some((entry) => entry.id === row.id), true);
	});

	it("lists only audit rows committed below the given xid bound", async () => {
		const row = await repo.audit.append({ id: id(13), actorId: id(7), action: "repo.bound", targetType: "project", targetId: id(1), outcome: "ok", requestHash: "hash" });
		assert.equal((await repo.audit.list({ action: "repo.bound", below: (BigInt(row.commitXid) + 1n).toString() })).some((entry) => entry.id === row.id), true);
		assert.equal((await repo.audit.list({ action: "repo.bound", below: row.commitXid })).some((entry) => entry.id === row.id), false);
	});

	it("searches project names as plain text, so _ and % are not wildcards", async () => {
		await repo.projects.create({ id: id(20), name: "a_b", workspacePolicy: "worktree" });
		await repo.projects.create({ id: id(21), name: "axb", workspacePolicy: "worktree" });
		assert.deepEqual((await repo.projects.list({ q: "a_b" })).map((row) => row.name), ["a_b"]);
		assert.deepEqual(await repo.projects.list({ q: "%" }), []);
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
