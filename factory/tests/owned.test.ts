// Owned files and directories: a run removes only what it created, judged by the identity (device and file index) it
// recorded at creation and re-reads at removal, never by the path alone. A path that now names a different file is left
// alone. "Another file at the same path" is made by moving the original away first, so its identity cannot be reused by
// the new file and the test does not depend on how the file system recycles indexes.
import assert from "node:assert/strict";
import { access, link, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { OwnedDir, OwnedFiles } from "../deploy/owned.ts";

const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

describe("owned files and directories", () => {
	let root: OwnedDir;
	let n = 0;
	const next = (): string => join(root.path, `case-${n++}`);

	before(async () => {
		root = await OwnedDir.make(tmpdir(), "af-test-owned-");
	});
	after(async () => {
		// Every case removes what it made; the root is removed only when it is empty, which proves it.
		const problems = await root.remove();
		assert.deepEqual(problems, []);
	});

	it("removes a file this run created", async () => {
		const owned = new OwnedFiles();
		const path = next();
		await (await owned.create(path)).close();
		assert.deepEqual(await owned.remove(path), "removed");
		assert.equal(await present(path), false);
	});

	it("creating never overwrites: an existing file is refused and not recorded", async () => {
		const owned = new OwnedFiles();
		const path = next();
		await writeFile(path, "someone else's");
		await assert.rejects(owned.create(path), /EEXIST/);
		assert.deepEqual(await owned.removeAll(), { removed: [], left: [], problems: [] });
		assert.equal(await readFile(path, "utf8"), "someone else's");
		await rm(path);
	});

	it("leaves a different file at the same path alone", async () => {
		const owned = new OwnedFiles();
		const path = next();
		const away = next();
		await (await owned.create(path)).close();
		await rename(path, away);
		await writeFile(path, "another run's file");
		assert.equal(await owned.remove(path), "left");
		assert.equal(await readFile(path, "utf8"), "another run's file");
		await rm(path);
		await rm(away);
	});

	it("a name that is already gone is not an error", async () => {
		const owned = new OwnedFiles();
		const path = next();
		await (await owned.create(path)).close();
		await rm(path);
		assert.equal(await owned.remove(path), "absent");
	});

	it("publishing by hard link records the published name with the identity of the staged file", async () => {
		const owned = new OwnedFiles();
		const staged = next();
		const final = next();
		await (await owned.create(staged)).close();
		await owned.publish(staged, final);
		assert.equal(await present(final), true);
		// Replace the published name by another file: the staged file is still ours and goes, the replacement stays.
		const away = next();
		await rename(final, away);
		await writeFile(final, "replacement");
		const result = await owned.removeAll();
		assert.deepEqual(result.problems, []);
		assert.deepEqual(result.left, [final]);
		assert.equal(await present(staged), false);
		assert.equal(await readFile(final, "utf8"), "replacement");
		await rm(final);
		await rm(away);
	});

	it("publishing never overwrites an existing name", async () => {
		const owned = new OwnedFiles();
		const staged = next();
		const final = next();
		await (await owned.create(staged)).close();
		await writeFile(final, "taken");
		await assert.rejects(owned.publish(staged, final), /EEXIST/);
		const result = await owned.removeAll();
		assert.deepEqual(result.removed, [staged]);
		assert.equal(await readFile(final, "utf8"), "taken");
		await rm(final);
	});

	it("a published name that is another hard link of the same file is still this run's", async () => {
		const owned = new OwnedFiles();
		const staged = next();
		const final = next();
		await (await owned.create(staged)).close();
		await owned.publish(staged, final);
		const extra = next();
		await link(final, extra);
		const result = await owned.removeAll();
		assert.deepEqual(result.problems, []);
		assert.equal(await present(staged), false);
		assert.equal(await present(final), false);
		assert.equal(await present(extra), true, "a name this run never recorded is not removed, even for the same file");
		await rm(extra);
	});

	it("a directory is removed when it holds only what this run created", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await (await dir.files.create(join(dir.path, "a"))).close();
		await (await dir.files.create(join(dir.path, "b"))).close();
		assert.deepEqual(await dir.remove(), []);
		assert.equal(await present(dir.path), false);
	});

	it("a directory that holds a file this run did not create is kept, with the file, and reported", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await (await dir.files.create(join(dir.path, "mine"))).close();
		await writeFile(join(dir.path, "foreign"), "x");
		const problems = await dir.remove();
		assert.equal(problems.length, 1);
		assert.match(problems[0] as string, /not empty|ENOTEMPTY/);
		assert.deepEqual(await readdir(dir.path), ["foreign"]);
		await rm(join(dir.path, "foreign"));
		assert.deepEqual(await dir.remove(), []);
	});

	it("a different directory at the same path is left alone", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		const away = next();
		await rename(dir.path, away);
		await mkdir(dir.path);
		await writeFile(join(dir.path, "x"), "another run's");
		const problems = await dir.remove();
		assert.deepEqual(problems, []);
		assert.equal(await readFile(join(dir.path, "x"), "utf8"), "another run's");
		await rm(join(dir.path, "x"));
		await rmdir(dir.path);
		await rmdir(away);
	});

	it("a tree written by code under test is adopted and removed bottom-up, with no recursive delete", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		const made = await dir.child("sub");
		await writeFile(join(made.path, "inner"), "1");
		await mkdir(join(made.path, "deeper"));
		await writeFile(join(made.path, "deeper", "leaf"), "2");
		await writeFile(join(dir.path, "top"), "3");
		await dir.adoptChildren();
		assert.deepEqual(await dir.remove(), []);
		assert.equal(await present(dir.path), false);
	});

	it("something that appears after adoption keeps its directory in place, and is reported", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await writeFile(join(dir.path, "early"), "1");
		await dir.adoptChildren();
		await writeFile(join(dir.path, "late"), "2");
		const problems = await dir.remove();
		assert.equal(problems.length, 1);
		assert.deepEqual(await readdir(dir.path), ["late"]);
		await rm(join(dir.path, "late"));
		assert.deepEqual(await dir.remove(), []);
	});

	it("child refuses an existing name", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await mkdir(join(dir.path, "taken"));
		await assert.rejects(dir.child("taken"), /EEXIST/);
		await rmdir(join(dir.path, "taken"));
		assert.deepEqual(await dir.remove(), []);
	});

	it("adoptChildren takes what a helper wrote into a private directory, and remove then clears it", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await writeFile(join(dir.path, "s1"), "1");
		await writeFile(join(dir.path, "s2"), "2");
		await dir.adoptChildren();
		assert.deepEqual(await dir.remove(), []);
		assert.equal(await present(dir.path), false);
	});
});
