// The access of the backup target and of the staging directory: a dump holds the whole database, so no dump byte may be
// written where the protection was not verified (the same rule as for the secret files, deploy/acl.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SID_ADMINISTRATORS, SID_SYSTEM, aclSids, pathsAccessProblems, restrictDirectory } from "../deploy/acl.ts";
import { backup } from "../deploy/backup/backup.ts";
import { OwnedDir } from "../deploy/owned.ts";
import { sharedStack, type TestStack } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const SID_USERS = "S-1-5-32-545";

// Gives a group that is not allowed access to `path` (and what is made inside it later): the Users group on Windows,
// group and others elsewhere.
const widen = (path: string): void => {
	if (process.platform === "win32") {
		const result = spawnSync("icacls", [path, "/grant", `*${SID_USERS}:(OI)(CI)R`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
	} else chmodSync(path, 0o755);
};

describe("acl.ts", () => {
	let scratch: OwnedDir;
	before(async () => {
		scratch = await makeScratch("af-test-acl-");
	});
	after(async () => {
		await disposeScratch(scratch);
	});

	it("reports an entry for a group that is not allowed, and restricting removes it", async () => {
		const dir = (await scratch.child("widened")).path;
		widen(dir);
		const open = pathsAccessProblems([dir]);
		assert.equal(open.length > 0, true, "a widened directory must be reported");
		assert.match(open.join("\n"), process.platform === "win32" ? new RegExp(SID_USERS) : /mode 755/);
		restrictDirectory(dir, "test directory");
		assert.deepEqual(pathsAccessProblems([dir]), []);
		if (process.platform === "win32") {
			assert.equal(aclSids(dir).includes(SID_USERS), false);
			assert.equal(aclSids(dir).includes(SID_SYSTEM) && aclSids(dir).includes(SID_ADMINISTRATORS), true);
		}
	});
});

describe("backup access rules", () => {
	let stack: TestStack;
	let work: OwnedDir;

	before(async () => {
		work = await makeScratch("af-test-backup-acl-");
		stack = await sharedStack();
	});
	after(async () => {
		const errors: unknown[] = [];
		await stack?.dispose().catch((error) => errors.push(error));
		await disposeScratch(work).catch((error) => errors.push(error));
		if (errors.length > 0) throw errors[0];
	});

	it("refuses an existing target that is open to another group, before any container work, and changes nothing in it", async () => {
		const target = (await work.child("open-target")).path;
		widen(target);
		// The project does not exist: when the refusal is about the access, it came before the container was looked up.
		await assert.rejects(
			backup({ project: "af-test-no-such-project", target }),
			(error: Error) => {
				assert.match(error.message, process.platform === "win32" ? new RegExp(SID_USERS) : /mode 755/);
				assert.match(error.message, /backup target/);
				assert.match(error.message, /deployment\.md/);
				return true;
			},
		);
		assert.deepEqual(await readdir(target), [], "nothing was written into the open target");
		assert.equal(pathsAccessProblems([target]).length > 0, true, "the open target was not silently changed");
	});

	it("a target that this run creates is restricted explicitly, and so are the published files", async () => {
		const parent = (await work.child("open-parent")).path;
		widen(parent); // a new directory under it inherits the wide access unless it is set explicitly
		const target = join(parent, "made-by-backup");
		const result = await backup({ project: stack.project, target });
		assert.deepEqual(pathsAccessProblems([target, result.dumpPath, `${result.dumpPath}.sha256`, result.manifestPath]), []);
		assert.deepEqual(result.leftovers, []);
	});

	it("restricts the staging directory explicitly before the dump is written, so the dump carries no wider access", async () => {
		const target = join((await work.child("staging-explicit")).path, "t");
		let staged = "";
		const result = await backup({
			project: stack.project,
			target,
			hooks: {
				// A wider entry on the staging directory itself, as an inherited one would be.
				beforeStagingRestricted: async (staging) => {
					staged = staging;
					widen(staging);
					assert.equal(pathsAccessProblems([staging]).length > 0, true);
				},
			},
		});
		assert.notEqual(staged, "", "the hook ran");
		assert.deepEqual(pathsAccessProblems([result.dumpPath, result.manifestPath]), []);
	});

	it("when the staging directory is not verified restricted, no dump byte is written and the run fails", async () => {
		const parent = (await work.child("staging-unverified")).path;
		const target = join(parent, "t");
		let dumpStarted = false;
		await assert.rejects(
			backup({
				project: stack.project,
				target,
				// The explicit restriction is replaced by nothing, and the staging directory is widened: the read-back must refuse.
				restrictStaging: () => {},
				hooks: {
					beforeStagingRestricted: async (staging) => {
						widen(staging);
					},
					afterDumpPublished: async () => {
						dumpStarted = true;
					},
				},
			}),
			(error: Error) => {
				assert.match(error.message, /staging/);
				assert.match(error.message, /nothing was written/);
				return true;
			},
		);
		assert.equal(dumpStarted, false);
		assert.deepEqual(await readdir(target), [], "no dump, no checksum, no manifest and no staging directory is left");
	});

	it("an existing restricted target is accepted and not changed", async () => {
		const target = (await work.child("restricted-target")).path;
		restrictDirectory(target, "test directory");
		await writeFile(join(target, "older.manifest.json"), "{}");
		const result = await backup({ project: stack.project, target });
		assert.deepEqual(pathsAccessProblems([target, result.dumpPath]), []);
		assert.equal((await readdir(target)).includes("older.manifest.json"), true);
	});
});
