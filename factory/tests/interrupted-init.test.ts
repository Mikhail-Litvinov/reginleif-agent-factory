// A data directory is served only after a recorded complete initialisation, and no failure path of the initialisation
// leaves a trust rule or a passfile behind.
//
// The image's entrypoint skips the initialisation whenever PG_VERSION exists, so a first start that died halfway used to
// come back on the next restart as a healthy database without its roles. Two layers are tested.
//
//  - The wrapper (deploy/postgres/entrypoint.sh) in the shared stack's container, against a stub that stands in for the
//    image's entrypoint and works in a scratch data directory of its own (the stack's real data directory is never touched):
//    a crash in the middle of the initialisation, a data directory without the marker, one with it, and the healthcheck.
//  - The whole thing on a scratch project: an init script that really fails (an invalid password in a secret file), a
//    second start of that container, and the proof that it never turns healthy.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort, ownedComposeArgs, ownedResources, run, runChecked, stackEnv } from "../deploy/lib.ts";
import { Cleanups, newSecretsDir, sharedStack, trackedProject, type TestStack } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const MARKER = ".af-init-complete";
const TRUST = /^\s*(local|host\w*)\s.*\strust\s*$/m;

// Stands in for the image's entrypoint. It records what it saw (the passfile and whether it exists at that moment), and
// in crash mode does what an initialisation does before it dies: PG_VERSION and a pg_hba.conf with the image's trust rule.
const STUB = [
	"#!/bin/bash",
	'echo "INVOKED $*" >> "$STUB_LOG"',
	'echo "PASSFILE ${PGPASSFILE:-none}" >> "$STUB_LOG"',
	'if [ -n "${PGPASSFILE:-}" ] && [ -e "$PGPASSFILE" ]; then echo PASSFILE_EXISTS >> "$STUB_LOG"; fi',
	'echo "INITDIR ${AF_INIT_DIR:-none}" >> "$STUB_LOG"',
	'if [ "$STUB_MODE" = crash ]; then',
	'  mkdir -p "$PGDATA"',
	'  echo 16 > "$PGDATA/PG_VERSION"',
	"  printf 'local all all scram-sha-256\\nhost all all all trust\\n' > \"$PGDATA/pg_hba.conf\"",
	"  kill -KILL $$",
	"fi",
	"exit 0",
	"",
].join("\n");

describe("interrupted initialisation: the wrapper", () => {
	let stack: TestStack;
	let container = "";
	const dir = `/tmp/af-stub-${randomBytes(4).toString("hex")}`;
	let counter = 0;

	const exec = (...command: string[]) => run("docker", ["exec", "-u", "root", container, ...command]);
	const sh = async (script: string): Promise<string> => runChecked("docker", ["exec", "-u", "root", container, "sh", "-c", script]);

	before(async () => {
		stack = await sharedStack();
		container = stack.container;
		await sh(`mkdir -p ${dir}/bin`);
		await runChecked("docker", ["exec", "-i", "-u", "root", container, "sh", "-c", `cat > ${dir}/bin/docker-entrypoint.sh && chmod +x ${dir}/bin/docker-entrypoint.sh`], { input: STUB });
	});
	after(async () => {
		try {
			// Only what this file made, entry by entry; rmdir fails (loudly) on a directory with anything foreign inside.
			const own = ["bin/docker-entrypoint.sh"];
			for (let n = 1; n <= counter; n++) own.push(`data-${n}/PG_VERSION`, `data-${n}/pg_hba.conf`, `data-${n}/${MARKER}`, `log-${n}`);
			const dirs = ["bin", ...Array.from({ length: counter }, (_, i) => `data-${i + 1}`)];
			if (container) await sh(`cd ${dir} && rm -f ${own.join(" ")} && for d in ${dirs.join(" ")}; do if [ -d "$d" ]; then rmdir "$d" || exit 1; fi; done && cd / && rmdir ${dir}`);
		} finally {
			await stack?.dispose();
		}
	});

	// A data directory of its own for one scenario and the wrapper run against it.
	const scenario = async (mode: "crash" | "ok", prepare = ""): Promise<{ data: string; log: string; result: Awaited<ReturnType<typeof exec>> }> => {
		const data = `${dir}/data-${++counter}`;
		const log = `${dir}/log-${counter}`;
		if (prepare) await sh(prepare.replaceAll("$D", data));
		const result = await exec("env", `PGDATA=${data}`, `STUB_MODE=${mode}`, `STUB_LOG=${log}`, "sh", "-c", `PATH=${dir}/bin:$PATH bash /etc/agent-factory/entrypoint.sh postgres`);
		return { data, log, result };
	};
	const read = async (path: string): Promise<string> => {
		const result = await exec("cat", path);
		return result.code === 0 ? result.stdout : "";
	};
	const exists = async (path: string): Promise<boolean> => (await exec("test", "-e", path)).code === 0;

	it("an initialisation that dies halfway leaves no passfile, no init directory and no trust rule", async () => {
		const { data, log, result } = await scenario("crash");
		assert.notEqual(result.code, 0);
		const seen = await read(log);
		assert.match(seen, /^PASSFILE_EXISTS$/m, "the stub did not see a passfile, so the test would pass vacuously");
		const passfile = /^PASSFILE (\S+)$/m.exec(seen)?.[1] ?? "none";
		assert.notEqual(passfile, "none");
		assert.equal(await exists(passfile), false, "the passfile is still there");
		const initDir = /^INITDIR (\S+)$/m.exec(seen)?.[1] ?? "none";
		assert.notEqual(initDir, "none");
		assert.equal(await exists(initDir), false, "the init directory is still there");
		const found = (await exec("find", "/dev/shm", "-name", "pgpass.*")).stdout.trim();
		assert.equal(found, "");
		assert.doesNotMatch(await read(`${data}/pg_hba.conf`), TRUST);
		assert.equal(await exists(`${data}/${MARKER}`), false);
	});

	it("a finished run (no failure) leaves no init directory either", async () => {
		const { log, result } = await scenario("ok");
		assert.equal(result.code, 0, result.stderr);
		const initDir = /^INITDIR (\S+)$/m.exec(await read(log))?.[1] ?? "none";
		assert.notEqual(initDir, "none");
		assert.equal(await exists(initDir), false);
	});

	it("a data directory with PG_VERSION and no marker is refused, and the image's entrypoint is never started", async () => {
		const { log, result } = await scenario("ok", "mkdir -p $D && echo 16 > $D/PG_VERSION");
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /refusing to start/);
		assert.equal(await exists(log), false, "the image's entrypoint was started");
	});

	it("the refusal closes a trust rule that an interrupted initialisation left", async () => {
		const prepare = "mkdir -p $D && echo 16 > $D/PG_VERSION && printf 'local all all scram-sha-256\\nhost all all all trust\\n' > $D/pg_hba.conf";
		const { data, result } = await scenario("ok", prepare);
		assert.notEqual(result.code, 0);
		const hba = await read(`${data}/pg_hba.conf`);
		assert.doesNotMatch(hba, TRUST);
		assert.match(hba, /^host all all all scram-sha-256$/m);
	});

	it("the refusal does not rewrite a pg_hba.conf that has no trust rule", async () => {
		const prepare = "mkdir -p $D && echo 16 > $D/PG_VERSION && printf 'local all all scram-sha-256\\nhost all all all scram-sha-256\\n' > $D/pg_hba.conf && touch -d '2001-02-03 04:05:06' $D/pg_hba.conf";
		const { data, result } = await scenario("ok", prepare);
		assert.notEqual(result.code, 0);
		// A rewrite (sed -i) would give the file a new modification time.
		assert.equal((await sh(`stat -c '%y' ${data}/pg_hba.conf`)).trim().slice(0, 19), "2001-02-03 04:05:06");
	});

	it("a data directory with the marker goes straight to the image's entrypoint and no passfile is made", async () => {
		const { log, result } = await scenario("ok", `mkdir -p $D && echo 16 > $D/PG_VERSION && : > $D/${MARKER}`);
		assert.equal(result.code, 0, result.stderr);
		const seen = await read(log);
		assert.match(seen, /^INVOKED postgres$/m);
		assert.match(seen, /^PASSFILE none$/m);
		assert.match(seen, /^INITDIR none$/m);
	});

	it("the healthcheck needs the marker and a real login, not only a server that answers", async () => {
		const test = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .Config.Healthcheck.Test}}", container])) as string[];
		assert.equal(test[0], "CMD-SHELL");
		const command = test[1] as string;
		assert.ok(command.includes(MARKER), "the healthcheck does not look at the marker");
		assert.match(command, /\bpsql\b/);
		assert.doesNotMatch(command, /PASSWORD/i);
		const good = await exec("sh", "-c", command);
		assert.equal(good.code, 0, good.stderr);
		const withoutMarker = await exec("sh", "-c", command.replaceAll(MARKER, ".af-init-never-made"));
		assert.notEqual(withoutMarker.code, 0);
	});
});

describe("interrupted initialisation: a scratch project whose init script fails", () => {
	const cleanups = new Cleanups();
	let container = "";
	let scratch = "";

	before(async () => {
		const scratchDir = await makeScratch("af-test-interrupted-");
		cleanups.add(() => disposeScratch(scratchDir));
		scratch = scratchDir.path;
		const secretsDir = await newSecretsDir(cleanups);
		// 10-roles.sh accepts only A-Z a-z 0-9 _ - in a password: this makes it fail after initdb and the roles' first steps.
		await writeFile(join(secretsDir, "af_migrator"), "bad!value");
		const port = await freePort();
		const { project, runId } = trackedProject(cleanups);
		const env = stackEnv({ project, secretsDir, port, runId });
		await runChecked("docker", ownedComposeArgs(project, runId, "create"), { env });
		const created = (await ownedResources(runId)).containers;
		assert.equal(created.length, 1);
		container = created[0] as string;
		// No automatic restart: each start below is made by the test, so what happens on a restart is observed, not raced.
		await runChecked("docker", ["update", "--restart=no", container]);
	});
	after(async () => {
		await cleanups.runAll();
	});

	const start = async (): Promise<number> => {
		await runChecked("docker", ["start", container]);
		return Number((await runChecked("docker", ["wait", container])).trim());
	};

	it("the failed first start leaves no trust rule and no marker in the volume", async () => {
		assert.notEqual(await start(), 0);
		assert.notEqual((await run("docker", ["cp", `${container}:/var/lib/postgresql/data/${MARKER}`, join(scratch, "marker")])).code, 0, "the marker exists");
		await runChecked("docker", ["cp", `${container}:/var/lib/postgresql/data/pg_hba.conf`, join(scratch, "pg_hba.conf")]);
		const hba = (await run("node", ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", join(scratch, "pg_hba.conf")])).stdout;
		assert.doesNotMatch(hba, TRUST);
	});

	it("the restart of that container is refused and never becomes healthy", async () => {
		await runChecked("docker", ["start", container]);
		let state = "";
		// Bounded polling of the daemon (every inspect is a process spawn), no sleeping.
		for (let i = 0; i < 600; i++) {
			state = (await runChecked("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", container])).trim();
			if (state.startsWith("exited") || state.endsWith("healthy") && !state.endsWith("unhealthy")) break;
		}
		assert.match(state, /^exited [1-9]\d* /, `the restarted container did not stop with an error: ${state}`);
		const logs = await run("docker", ["logs", container]);
		assert.match(logs.stdout + logs.stderr, /refusing to start/);
	});
});
