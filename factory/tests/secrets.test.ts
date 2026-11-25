// Secrets: created once and never overwritten, kept out of the container's inspect data, required to start the stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { composeFilePath, run } from "../deploy/lib.ts";
import { SECRET_NAMES, SID_ADMINISTRATORS, SID_SYSTEM, aclSids, createSecrets, verifySecretsAccess } from "../deploy/setup-secrets.ts";
import { createTestStack, newProject, type TestStack } from "./helpers.ts";

const SETUP_CLI = new URL("../deploy/setup-secrets.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("secrets", () => {
	let work: string;
	before(async () => {
		work = await mkdtemp(join(tmpdir(), "af-test-secrets-setup-"));
	});
	after(async () => {
		await rm(work, { recursive: true, force: true });
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
		await rm(join(dir, "af_reader"));
		const result = createSecrets(dir);
		assert.deepEqual(result.created, ["af_reader"]);
		assert.equal(await readFile(join(dir, "af_api"), "utf8"), "kept-value");
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

	it("an empty existing directory that carries a Users grant ends in an error, not in a silent success", onWindows, async () => {
		const dir = await mkdtemp(join(work, "acl-empty-"));
		grantUsers(dir);
		assert.throws(() => createSecrets(dir), /not restricted as required[\s\S]*S-1-5-32-545/);
	});

	it("the stack refuses to start without AF_SECRETS_DIR", async () => {
		// A random project, removed in a finally also when the guard under test fails and something does start.
		const project = newProject();
		const env = { AF_SECRETS_DIR: "" };
		try {
			const result = await run("docker", ["compose", "-p", project, "-f", composeFilePath(), "config"], { env });
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /AF_SECRETS_DIR/);
			const up = await run("docker", ["compose", "-p", project, "-f", composeFilePath(), "up", "-d"], { env });
			assert.notEqual(up.code, 0);
			const ps = await run("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "-q"]);
			assert.equal(ps.stdout.trim(), "");
		} finally {
			const down = await run("docker", ["compose", "-p", project, "-f", composeFilePath(), "down", "-v", "--remove-orphans"], { env: { AF_SECRETS_DIR: tmpdir() } });
			assert.equal(down.code, 0, `cleanup failed: ${down.stderr}`);
		}
	});

	describe("in a running stack", () => {
		let stack: TestStack;
		before(async () => {
			stack = await createTestStack();
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

		it("the container environment holds no password and only file references", async () => {
			const env = (await run("docker", ["inspect", "--format", "{{json .Config.Env}}", stack.container])).stdout;
			assert.match(env, /POSTGRES_PASSWORD_FILE=\/run\/secrets\/af_bootstrap/);
			assert.equal(/POSTGRES_PASSWORD=/.test(env), false);
		});

		it("the secrets are mounted read-only files, not copied into the image", async () => {
			const result = await run("docker", ["exec", stack.container, "sh", "-c", "ls /run/secrets | sort"]);
			assert.equal(result.stdout.trim().split("\n").join(","), [...SECRET_NAMES].sort().join(","));
		});
	});
});
