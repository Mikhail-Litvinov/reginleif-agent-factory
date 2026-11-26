// Secrets: created once and never overwritten, kept out of the container's inspect data, required to start the stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, renameSync, statSync, writeFileSync, type BigIntStats } from "node:fs";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ownedComposeArgs, run } from "../deploy/lib.ts";
import type { OwnedDir } from "../deploy/owned.ts";
import { SECRET_NAMES, SID_ADMINISTRATORS, SID_SYSTEM, aclSids, createSecrets, removeIfSame, verifySecretsAccess } from "../deploy/setup-secrets.ts";
import { Cleanups, leftovers, sharedStack, trackedProject, type TestStack } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const SETUP_CLI = new URL("../deploy/setup-secrets.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("secrets", () => {
	let scratch: OwnedDir | undefined;
	let work: string;
	before(async () => {
		scratch = await makeScratch("af-test-secrets-setup-");
		work = scratch.path;
	});
	after(async () => {
		await disposeScratch(scratch);
	});

	it("creates one random file per account, then never overwrites an existing one", async () => {
		const dir = join(work, "first");
		const first = createSecrets(dir);
		assert.deepEqual(first.created, [...SECRET_NAMES]);
		const before = await Promise.all(SECRET_NAMES.map((name) => readFile(join(dir, name), "utf8")));
		assert.equal(new Set(before).size, SECRET_NAMES.length, "passwords must differ");
		for (const password of before) assert.match(password, /^[A-Za-z0-9_-]{43}$/);

		const again = createSecrets(dir);
		assert.deepEqual(again.created, []);
		assert.deepEqual(again.kept, [...SECRET_NAMES]);
		const after = await Promise.all(SECRET_NAMES.map((name) => readFile(join(dir, name), "utf8")));
		assert.deepEqual(after, before);
	});

	it("fills in only a missing file and leaves a changed one as it is", async () => {
		const dir = join(work, "partial");
		createSecrets(dir);
		await writeFile(join(dir, "af_api"), "kept-value");
		// Moved aside, not deleted: the scratch directory's own cleanup removes everything inside it.
		await rename(join(dir, "af_reader"), join(dir, "af_reader.moved"));
		const result = createSecrets(dir);
		assert.deepEqual(result.created, ["af_reader"]);
		assert.equal(await readFile(join(dir, "af_api"), "utf8"), "kept-value");
	});

	// A kill between the exclusive create and the write leaves an empty file; reporting it as "kept" would start the
	// stack with a role that has no password. The same for a file with content the init script would refuse.
	for (const [label, content] of [
		["empty", ""],
		["only a newline", "\n"],
		["with a character outside A-Z a-z 0-9 _ -", "bad value!"],
	] as const) {
		it(`an existing secret file that is ${label} is refused with its name and the recovery step, and is not changed or filled in`, async () => {
			const dir = join(work, `invalid-${label.replace(/\W+/g, "-")}`);
			createSecrets(dir);
			await writeFile(join(dir, "af_control"), content);
			const others = await Promise.all(SECRET_NAMES.filter((n) => n !== "af_control").map((n) => readFile(join(dir, n), "utf8")));
			assert.throws(() => createSecrets(dir), (error: Error) => /af_control/.test(error.message) && /remove that one file, then run (the command|it) again/.test(error.message));
			assert.equal(await readFile(join(dir, "af_control"), "utf8"), content, "the file must not be overwritten");
			const after = await Promise.all(SECRET_NAMES.filter((n) => n !== "af_control").map((n) => readFile(join(dir, n), "utf8")));
			assert.deepEqual(after, others);
			const cli = await run("node", [SETUP_CLI, dir]);
			assert.equal(cli.code, 1);
			assert.match(cli.stderr, /af_control/);
			assert.doesNotMatch(cli.stdout, /kept/);
			const check = await run("node", [SETUP_CLI, "--check", dir]);
			assert.equal(check.code, 1, "--check reports it too");
			assert.match(check.stderr, /af_control/);
		});
	}

	it("a secret file with a trailing newline (as the init script reads it) is kept", async () => {
		const dir = join(work, "newline-kept");
		createSecrets(dir);
		await writeFile(join(dir, "af_api"), "kept-value\n");
		assert.ok(createSecrets(dir).kept.includes("af_api"));
	});

	it("the command prints no password and exits 0 on a repeat run", async () => {
		const dir = join(work, "cli");
		const one = await run("node", [SETUP_CLI, dir]);
		assert.equal(one.code, 0, one.stderr);
		for (const file of await readdir(dir)) {
			const password = await readFile(join(dir, file), "utf8");
			assert.equal((one.stdout + one.stderr).includes(password), false);
		}
		const two = await run("node", [SETUP_CLI, dir]);
		assert.equal(two.code, 0, two.stderr);
		assert.match(two.stdout, /created: none/);
	});

	it("the command without a directory is a usage error", async () => {
		const result = await run("node", [SETUP_CLI]);
		assert.equal(result.code, 2);
	});

	const onWindows = { skip: process.platform !== "win32" };
	const USERS_SID = "S-1-5-32-545";
	// Inheritance flags apply to a directory only (on a file icacls accepts them and records nothing).
	const grantUsers = (path: string, isDirectory = true): void => {
		const result = spawnSync("icacls", [path, "/grant", `*${USERS_SID}:${isDirectory ? "(OI)(CI)" : ""}R`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
	};

	it("the ACL read back by SID holds only the current user, SYSTEM and Administrators, on the directory and each file", onWindows, () => {
		const dir = join(work, "acl-ok");
		createSecrets(dir);
		assert.deepEqual(verifySecretsAccess(dir), []);
		for (const path of [dir, ...SECRET_NAMES.map((n) => join(dir, n))]) {
			const sids = new Set(aclSids(path));
			assert.equal(sids.has(USERS_SID), false, path);
			assert.ok(sids.has(SID_SYSTEM) && sids.has(SID_ADMINISTRATORS), path);
		}
	});

	// The documented commands take a path the user typed, and a Windows path often holds a space or a quote: the ACL is
	// read back for the exact path, never for the part of it before the first space.
	it("a directory whose path holds spaces is locked and verified like any other, and a Users grant on it is still found", onWindows, async () => {
		const dir = join(work, "with some spaces", "secrets dir");
		createSecrets(dir);
		assert.deepEqual(verifySecretsAccess(dir), []);
		assert.ok(aclSids(dir).length >= 3, "the ACL of a path with spaces must be read back, not come back empty");
		grantUsers(dir);
		assert.ok(aclSids(dir).includes(USERS_SID));
		assert.throws(() => createSecrets(dir), /refused[\s\S]*S-1-5-32-545/);
		const check = await run("node", [SETUP_CLI, "--check", dir]);
		assert.equal(check.code, 1);
		assert.match(check.stderr, /S-1-5-32-545/);
	});

	it("a reused directory with a grant to the Users SID is refused, named, and not changed", onWindows, async () => {
		const dir = join(work, "acl-users-dir");
		createSecrets(dir);
		grantUsers(dir);
		assert.throws(() => createSecrets(dir), /refused[\s\S]*S-1-5-32-545/);
		assert.ok(aclSids(dir).includes(USERS_SID), "the refusal must not silently fix the access");
		const check = await run("node", [SETUP_CLI, "--check", dir]);
		assert.equal(check.code, 1);
		assert.match(check.stderr, /S-1-5-32-545/);
	});

	it("a grant to the Users SID on one secret file only is refused too", onWindows, () => {
		const dir = join(work, "acl-users-file");
		createSecrets(dir);
		grantUsers(join(dir, "af_api"), false);
		assert.throws(() => createSecrets(dir), /refused[\s\S]*af_api[\s\S]*S-1-5-32-545/);
	});

	it("an empty existing directory that carries a Users grant has the grant removed before any secret is written", onWindows, async () => {
		const dir = await mkdtemp(join(work, "acl-empty-"));
		grantUsers(dir);
		assert.ok(aclSids(dir).includes(USERS_SID));
		createSecrets(dir);
		assert.deepEqual(verifySecretsAccess(dir), []);
		for (const path of [dir, ...SECRET_NAMES.map((n) => join(dir, n))]) assert.equal(aclSids(path).includes(USERS_SID), false, path);
	});

	// A directory that was there before and holds somebody's unrelated files is not ours to re-protect: its access is
	// verified and, when too wide, the command refuses and changes nothing (an ACL change would also reach what the owner keeps there).
	it("an existing directory with unrelated files and a Users grant is refused and its ACL is not changed", onWindows, async () => {
		const dir = await mkdtemp(join(work, "acl-foreign-"));
		await writeFile(join(dir, "notes.txt"), "not ours");
		grantUsers(dir);
		const before = [...aclSids(dir)].sort();
		assert.ok(before.includes(USERS_SID));
		assert.throws(() => createSecrets(dir), /refused/);
		assert.deepEqual([...aclSids(dir)].sort(), before, "the refusal must not change the access");
		assert.deepEqual(await readdir(dir), ["notes.txt"], "no secret may be written there");
	});

	// No secret byte is written to a place whose protection was not verified first: when the directory cannot be made
	// restricted (here the locking step is replaced by one that does nothing), the command fails with no secret file written.
	it("when the directory is not verified restricted, no secret file is written at all", async () => {
		const dir = await mkdtemp(join(work, "unverified-"));
		if (process.platform === "win32") grantUsers(dir);
		else chmodSync(dir, 0o755);
		assert.throws(() => createSecrets(dir, { lock: () => {} }), /not restricted as required/);
		assert.deepEqual(await readdir(dir), []);
	});

	// The protection of the file itself is verified before any secret byte goes into it: the file is created empty and
	// exclusively, its own effective access is checked, and only then is the content written. A failing check removes the
	// empty file.
	it("a secret file is created empty, its own access is verified, and nothing is written when that fails", async () => {
		const dir = await mkdtemp(join(work, "file-check-"));
		const seen: string[] = [];
		assert.throws(
			() =>
				createSecrets(dir, {
					verifyFile: (path) => {
						seen.push(path);
						assert.equal(statSync(path).size, 0, "the file must still be empty when its access is verified");
						return ["injected problem"];
					},
				}),
			/injected problem/,
		);
		assert.equal(seen.length, 1, "the first failing file stops the run");
		assert.deepEqual(await readdir(dir), [], "the empty file is removed and no file holds a secret");
	});

	// The failure path removes only the file this run created, identified by what it recorded at creation; a different file
	// that took the path meanwhile is left alone.
	it("a failed check never removes a different file that took the path of the one this run created", async () => {
		const dir = await mkdtemp(join(work, "file-swap-"));
		const first = SECRET_NAMES[0];
		const moved = join(dir, "moved-away");
		assert.throws(
			() =>
				createSecrets(dir, {
					verifyFile: (path) => {
						renameSync(path, moved);
						writeFileSync(path, "someone else's file");
						return ["injected problem"];
					},
				}),
			/injected problem/,
		);
		assert.equal(await readFile(join(dir, first), "utf8"), "someone else's file");
	});

	// "Same file" needs a proven identity. An unreadable inode (reported as 0, which a filesystem or a failed query can
	// give for any file) or a different creation time is not proof, and the file is left: a leftover empty file is
	// harmless and is found by the next run, a removed foreign file is not.
	it("removeIfSame leaves a file whose identity is not proven the same", async () => {
		const dir = await mkdtemp(join(work, "same-"));
		const file = join(dir, "f");
		const stat = (path: string): BigIntStats => lstatSync(path, { bigint: true });
		writeFileSync(file, "x");
		const real = stat(file);
		const unknown = { ...real, ino: 0n } as BigIntStats;
		removeIfSame(file, unknown, () => unknown);
		assert.ok(existsSync(file), "an unknown inode (0 on both sides) is not an identity");
		removeIfSame(file, { ...real, birthtimeNs: real.birthtimeNs + 1n } as BigIntStats);
		assert.ok(existsSync(file), "a different creation time is a different file");
		removeIfSame(file, real);
		assert.equal(existsSync(file), false, "the file with the recorded identity is removed");
	});

	it("every secret file is verified on its own before its content is written", async () => {
		const dir = await mkdtemp(join(work, "file-check-all-"));
		const sizes: number[] = [];
		createSecrets(dir, {
			verifyFile: (path) => {
				sizes.push(statSync(path).size);
				return [];
			},
		});
		assert.deepEqual(sizes, SECRET_NAMES.map(() => 0));
		for (const name of SECRET_NAMES) assert.ok(statSync(join(dir, name)).size > 0, name);
	});

	it("the stack refuses to start without AF_SECRETS_DIR", async () => {
		// Everything this test could create carries its own run label, and only that label is removed in the finally, also
		// when the guard under test fails and something does start.
		const cleanups = new Cleanups();
		const { project, runId } = trackedProject(cleanups);
		const env = { AF_SECRETS_DIR: "", AF_RUN_ID: runId };
		try {
			const result = await run("docker", ownedComposeArgs(project, runId, "config"), { env });
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /AF_SECRETS_DIR/);
			const up = await run("docker", ownedComposeArgs(project, runId, "up", "-d"), { env });
			assert.notEqual(up.code, 0);
			assert.deepEqual(await leftovers(runId), []);
		} finally {
			await cleanups.runAll();
		}
	});

	describe("in a running stack", () => {
		let stack: TestStack;
		before(async () => {
			// The run-wide stack: these checks only inspect it.
			stack = await sharedStack();
		});
		after(async () => {
			await stack?.dispose();
		});

		it("no password appears in docker inspect of the container, its image or its volume", async () => {
			const container = (await run("docker", ["inspect", stack.container])).stdout;
			const volumes = (await run("docker", ["volume", "inspect", `${stack.project}_pgdata`])).stdout;
			assert.ok(container.length > 100 && volumes.length > 10);
			for (const name of SECRET_NAMES) {
				const password = (await stack.secret(name)).trim();
				assert.equal(container.includes(password), false, `${name} found in container inspect`);
				assert.equal(volumes.includes(password), false, `${name} found in volume inspect`);
			}
		});

		it("the container environment holds no password variable of either form, only the file path of the initdb option", async () => {
			const env = (await run("docker", ["inspect", "--format", "{{json .Config.Env}}", stack.container])).stdout;
			assert.equal(/POSTGRES_PASSWORD/.test(env), false);
			assert.match(env, /--pwfile=\/run\/secrets\/af_bootstrap/);
		});

		it("the secrets are mounted read-only files, not copied into the image", async () => {
			const result = await run("docker", ["exec", stack.container, "sh", "-c", "ls /run/secrets | sort"]);
			assert.equal(result.stdout.trim().split("\n").join(","), [...SECRET_NAMES].sort().join(","));
		});
	});
});
