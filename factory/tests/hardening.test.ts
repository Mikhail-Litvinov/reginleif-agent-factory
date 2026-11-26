// Two properties of a running server that must hold together with its other behaviour, on one shared started stack:
// no password in any process environment, command line, inspect output or log; and application accounts reachable only
// from the project's own network (pg_hba "samenet").
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { backup } from "../deploy/backup/backup.ts";
import { PsqlSession, psql, run, runChecked } from "../deploy/lib.ts";
import { SECRET_NAMES } from "../deploy/setup-secrets.ts";
import { Cleanups, createTestStack, type TestStack } from "./helpers.ts";

// Prints every process's command line and environment in the container, as the given user.
const SCAN = "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; tr '\\0' '\\n' < $p/environ 2>/dev/null; done";

describe("hardening", () => {
	let stack: TestStack;
	let work: string;
	const cleanups = new Cleanups();

	before(async () => {
		cleanups.add(async () => {
			if (work) await rm(work, { recursive: true, force: true });
		});
		work = await mkdtemp(join(tmpdir(), "af-test-hardening-"));
		stack = await createTestStack();
	});
	after(async () => {
		await stack?.dispose();
		await cleanups.runAll();
	});

	const passwords = async (): Promise<Array<[string, string]>> =>
		Promise.all(SECRET_NAMES.map(async (name): Promise<[string, string]> => [name, (await stack.secret(name)).trim()]));

	const assertNone = async (where: string, text: string): Promise<void> => {
		for (const [name, password] of await passwords()) assert.equal(text.includes(password), false, `${name} found in ${where}`);
	};

	it("no password in inspect, logs, or any process command line or environment, also during a dump", { timeout: 180_000 }, async () => {
		const session = new PsqlSession(stack.container, "af_backup");
		const holder = new PsqlSession(stack.container, "af_migrator");
		try {
			assert.equal(await session.query("SELECT 1;"), "1");
			// The dump is held at a known point instead of lasting long: pg_dump takes an ACCESS SHARE lock on every object it
			// dumps, including a materialized view (the backup's own row counting reads tables only, so it is not held up
			// by it). While a lock holder keeps the view ACCESS EXCLUSIVE, pg_dump is alive and waiting; the scans run, and
			// only then the lock is released. No duration is involved.
			await psql(stack.container, "af_migrator", "CREATE TABLE small AS SELECT g FROM generate_series(1, 100) g; CREATE MATERIALIZED VIEW held AS SELECT g FROM small;");
			// (LOCK TABLE refuses a materialized view; a refresh inside an open transaction takes the same lock and keeps it.)
			assert.equal(await holder.query("BEGIN; REFRESH MATERIALIZED VIEW held; SELECT 'locked';"), "locked");
			let sawDump = false;
			let sawPsql = false;
			let done = false;
			const running = backup({ project: stack.project, target: join(work, "scan") }).finally(() => {
				done = true;
			});
			const scanOnce = async (): Promise<void> => {
				for (const user of ["root", "postgres"]) {
					// Other users' processes are unreadable to this user (a non-zero exit): that is expected, only output counts.
					const scan = (await run("docker", ["exec", "-u", user, stack.container, "sh", "-c", SCAN])).stdout;
					await assertNone(`processes of ${user}`, scan);
					sawDump ||= /pg_dump/.test(scan);
					sawPsql ||= /psql/.test(scan);
				}
			};
			// Scan until pg_dump is seen (it is blocked on the lock, so it cannot have finished), then release the lock.
			while (!sawDump && !done) await scanOnce();
			assert.equal(done, false, "the backup finished while the view was locked: the lock did not hold pg_dump");
			assert.equal(await holder.query("ROLLBACK; SELECT 'released';"), "released");
			await running;
			await scanOnce();
			assert.ok(sawPsql, "the scan never saw a psql process: it proves nothing");
			assert.ok(sawDump, "the scan never saw pg_dump running: it proves nothing");
			await assertNone("docker inspect", (await run("docker", ["inspect", stack.container])).stdout);
			const logs = await run("docker", ["logs", stack.container]);
			await assertNone("container logs", logs.stdout + logs.stderr);
			// The final server process (pid 1) holds no password variable either.
			const env = await runChecked("docker", ["exec", "-u", "postgres", stack.container, "sh", "-c", "tr '\\0' '\\n' < /proc/1/environ"]);
			assert.equal(/PASSWORD/i.test(env), false, "PGPASSWORD or POSTGRES_PASSWORD in the server environment");
		} finally {
			await holder.close();
			await session.close();
		}
	});

	it("the healthcheck is a TCP pg_isready that carries no password", async () => {
		const health = (await runChecked("docker", ["inspect", "--format", "{{json .Config.Healthcheck.Test}}", stack.container])).trim();
		assert.match(health, /pg_isready/);
		assert.match(health, /127\.0\.0\.1/);
		assert.equal(/PGPASSWORD|PASSWORD/i.test(health), false);
	});

	// The three checks share nothing but read access to the started stack (each client container and network is its own), so
	// they run side by side; each client container takes seconds to start, which is what the time here is.
	describe("network reach", { concurrency: 3 }, () => {
		// The image of the server container never changes during the file: asked once, not before every client.
		let imageName: Promise<string> | undefined;
		const image = (): Promise<string> =>
			(imageName ??= runChecked("docker", ["inspect", "--format", "{{.Config.Image}}", stack.container]).then((text) => text.trim()));

		// Runs a short-lived client container on `network`; it reads the password from the read-only secrets mount into a
		// passfile (never an environment variable). It carries the stack's run label, so the checked removal of that label
		// (stack.dispose) removes it should --rm not have, and a docker failure there fails the run.
		const client = async (network: string, host: string, role: string, extra = ""): Promise<{ code: number; text: string }> => {
			const name = `af-test-client-${randomBytes(4).toString("hex")}`;
			const script = `umask 077; f=$(mktemp); printf '*:*:*:${role}:%s\\n' "$(cat /s/${role})" > "$f"; ` +
				`PGPASSFILE="$f" PGCONNECT_TIMEOUT=3 psql -w -h ${host} -U ${role} -d agent_factory ${extra} -Atc 'select 42'`;
			const result = await run("docker", [
				"run", "--rm", "--name", name, "--label", `af.run=${stack.runId}`, "--network", network,
				"--mount", `type=bind,source=${stack.secretsDir},target=/s,readonly`,
				"--entrypoint", "sh", await image(), "-c", script,
			]);
			return { code: result.code ?? -1, text: result.stdout + result.stderr };
		};

		it("pg_hba admits the application accounts from samenet only, and no host line is open to all", async () => {
			const rules = await psql(stack.container, "af_bootstrap",
				"SELECT type || ' ' || database::text || ' ' || user_name::text || ' ' || coalesce(address, '') || ' ' || auth_method FROM pg_hba_file_rules ORDER BY line_number;",
				{ database: "postgres" });
			const hostLines = rules.split("\n").filter((l) => l.startsWith("host "));
			assert.ok(hostLines.length > 0);
			for (const line of hostLines) {
				if (/reject$/.test(line)) continue;
				assert.match(line, / samenet scram-sha-256$/, line);
			}
		});

		it("a container on the project's own network connects, a superuser from it is refused", async () => {
			const own = `${stack.project}_default`;
			const [ok, root] = await Promise.all([client(own, "postgres", "af_api"), client(own, "postgres", "af_bootstrap")]);
			assert.equal(ok.code, 0, ok.text);
			assert.match(ok.text, /42/);
			assert.notEqual(root.code, 0);
		});

		it("a container on another docker network cannot reach the server", async () => {
			const other = `af-test-net-${randomBytes(4).toString("hex")}`;
			const [, ipText] = await Promise.all([
				runChecked("docker", ["network", "create", "--label", `af.run=${stack.runId}`, other]),
				runChecked("docker", ["inspect", "--format", `{{(index .NetworkSettings.Networks "${stack.project}_default").IPAddress}}`, stack.container]),
			]);
			const ip = ipText.trim();
			assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
			const refused = await client(other, ip, "af_api");
			assert.notEqual(refused.code, 0, refused.text);
			assert.equal(refused.text.includes("42"), false);
		});
	});
});
