// Owned files and directories: a run removes only what it created, judged by the identity (device and file index) it
// recorded at creation and re-reads at removal, never by the path alone. A path that now names a different file is left
// alone. "Another file at the same path" is made by moving the original away first, so its identity cannot be reused by
// the new file and the test does not depend on how the file system recycles indexes.
//
// The tests call no delete of their own (the removal guard forbids it outside owned.ts): the foreign fixtures a case
// leaves behind (a file made by "another run", a moved-away original) are swept by the root, which adopts everything in
// its private directory once the cases are done and removes it by identity.
import assert from "node:assert/strict";
import { access, link, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isKnownId, sameId, type FileId } from "../deploy/identity.ts";
import { OwnedDir, OwnedFiles } from "../deploy/owned.ts";

const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

describe("file identity", () => {
	const id: FileId = { dev: 1n, ino: 42n, birthtimeNs: 1000n };

	it("two identities that agree in every part are the same", () => {
		assert.equal(sameId(id, { ...id }), true);
	});
	it("a different device, file index or creation time is not the same", () => {
		assert.equal(sameId(id, { ...id, dev: 2n }), false);
		assert.equal(sameId(id, { ...id, ino: 43n }), false);
		assert.equal(sameId(id, { ...id, birthtimeNs: 1001n }), false);
	});
	it("an unknown file index (0) proves nothing, not even against itself", () => {
		const unknown: FileId = { dev: 1n, ino: 0n, birthtimeNs: 1000n };
		assert.equal(isKnownId(unknown), false);
		assert.equal(sameId(unknown, { ...unknown }), false);
		assert.equal(sameId(unknown, id), false);
	});
	it("a missing identity is never the same as anything", () => {
		assert.equal(sameId(undefined, undefined), false);
		assert.equal(sameId(id, undefined), false);
	});
});

describe("owned files and directories", () => {
	let root: OwnedDir;
	let n = 0;
	const next = (): string => join(root.path, `case-${n++}`);

	before(async () => {
		root = await OwnedDir.make(tmpdir(), "af-test-owned-");
	});
	after(async () => {
		// Each case removes what it made. What the cases left as foreign fixtures is inside this private directory, so it
		// is adopted now and removed by identity; the root goes only when nothing else is in it.
		await root.adoptChildren();
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
		assert.deepEqual(await owned.removeAll(), { removed: [], left: [], problems: [], stopped: false });
		assert.equal(await readFile(path, "utf8"), "someone else's");
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
	});

	it("a name that is already gone is not an error", async () => {
		const owned = new OwnedFiles();
		const path = next();
		await (await owned.create(path)).close();
		await rename(path, next());
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
		// The owner decides about the foreign file: once it is adopted on purpose, the directory goes.
		await dir.adoptChildren();
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
		await dir.adoptChildren();
		assert.deepEqual(await dir.remove(), []);
	});

	it("child refuses an existing name", async () => {
		const dir = await OwnedDir.make(root.path, "d-");
		await mkdir(join(dir.path, "taken"));
		await assert.rejects(dir.child("taken"), /EEXIST/);
		await dir.adoptChildren();
		assert.deepEqual(await dir.remove(), []);
	});

	it("adopting an identity whose file index is unknown is refused", async () => {
		const owned = new OwnedFiles();
		const path = next();
		await writeFile(path, "x");
		await assert.rejects(owned.adopt(path, { dev: 1n, ino: 0n, birthtimeNs: 5n }), /unknown identity/);
		assert.equal(owned.size, 0);
	});

	it("a file whose creation time differs from the recorded one is not removed, whatever its index", async () => {
		// The recorded identity is made up with a wrong creation time: the file at the path has the same device and index.
		const owned = new OwnedFiles();
		const path = next();
		await writeFile(path, "x");
		const stats = await lstat(path, { bigint: true });
		await owned.adopt(path, { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs + 1n });
		assert.equal(await owned.remove(path), "left");
		assert.equal(await present(path), true);
	});

	describe("the parent is checked again before every removal", () => {
		// A swap is made by a hook that runs right before each re-check. "Another directory at the same path" holds a hard
		// link to a file this run recorded: file by file it looks like ours (same device, index and creation time), only the
		// directory it sits in is not. Removing it would take a name out of a directory this run never made.
		// The returned hook counts its calls and, on call number `at`, moves `target` away and puts another directory under
		// its name, holding a hard link to the file `linked` when one is named.
		const swapAt = (target: OwnedDir, at: number, linked?: string): { beforeStep: () => Promise<void>; calls: () => number } => {
			const away = next();
			let calls = 0;
			return {
				calls: () => calls,
				beforeStep: async () => {
					calls++;
					if (calls !== at) return;
					await rename(target.path, away);
					await mkdir(target.path);
					if (linked !== undefined) await link(join(away, linked), join(target.path, linked));
				},
			};
		};

		it("a directory swapped before a file is removed keeps the foreign link", async () => {
			const dir = await OwnedDir.make(root.path, "d-");
			await (await dir.files.create(join(dir.path, "a"))).close();
			await (await dir.files.create(join(dir.path, "b"))).close();
			// Steps: before "b" (1), before "a" (2). Swap at 2: the link to "a" sits in a directory this run did not make.
			const probe = swapAt(dir, 2, "a");
			const problems = await dir.remove({ beforeStep: probe.beforeStep });
			assert.ok(probe.calls() >= 2, "the hook did not run, so nothing was proved");
			assert.equal(await present(join(dir.path, "a")), true, "a name in a directory that is not ours was removed");
			assert.equal(problems.length, 1);
			assert.match(problems[0] as string, /replaced during cleanup/);
		});

		it("a directory swapped just before its own removal is not removed", async () => {
			const dir = await OwnedDir.make(root.path, "d-");
			await (await dir.files.create(join(dir.path, "a"))).close();
			// Steps: before "a" (1), before the directory itself (2). Swap at 2: an empty directory takes the old one's place.
			const probe = swapAt(dir, 2);
			const problems = await dir.remove({ beforeStep: probe.beforeStep });
			assert.equal(probe.calls(), 2);
			assert.equal(await present(dir.path), true, "an empty directory that is not ours was removed");
			assert.equal(problems.length, 1);
			assert.match(problems[0] as string, /replaced during cleanup/);
		});

		it("a subdirectory swapped before its files are removed is not entered", async () => {
			const dir = await OwnedDir.make(root.path, "d-");
			const sub = await dir.child("sub");
			await (await sub.files.create(join(sub.path, "a"))).close();
			// Steps: the top directory before the subdirectory (1), the subdirectory before its file "a" (2).
			const probe = swapAt(sub, 2, "a");
			const problems = await dir.remove({ beforeStep: probe.beforeStep });
			assert.ok(probe.calls() >= 2, "the hook did not run, so nothing was proved");
			assert.equal(await present(join(sub.path, "a")), true, "a name in a directory that is not ours was removed");
			assert.ok(problems.some((p) => /replaced during cleanup/.test(p)), problems.join("; "));
		});
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
