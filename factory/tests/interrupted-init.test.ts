// A data directory is served only after a recorded complete initialisation, and no way out of the initialisation, a
// SIGKILL of the wrapper included, leaves a trust rule in the volume or a credential file behind.
//
// The image's entrypoint skips the initialisation whenever PG_VERSION exists, so a first start that died halfway used to
// come back on the next restart as a healthy database without its roles. A trust rule must never exist at all: the
// wrapper asks the image for none (no POSTGRES_HOST_AUTH_METHOD), so a kill at any instant leaves nothing to close.
// Two layers are tested.
//
//  - The wrapper (deploy/postgres/entrypoint.sh) in the shared stack's container, against a stub that stands in for the
//    image's entrypoint and works in a scratch data directory of its own (the stack's real data directory is never touched):
//    a crash in the middle of the initialisation, a SIGKILL of the wrapper itself, a data directory without the marker,
//    one with it, and the healthcheck (including a check that docker kills on its timeout).
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

const HEALTH_PASSFILE = "/dev/shm/af-healthcheck.pgpass";

// Stands in for the image's entrypoint. It records what it saw (the service file that carries the bootstrap password to
// the image's own psql calls, its mode, owner and content at that moment), and in the two failing modes does what an
// initialisation does before it dies: PG_VERSION and the pg_hba.conf the image writes. The image appends
// `host all all all $POSTGRES_HOST_AUTH_METHOD`, scram-sha-256 when that variable is unset (docker-entrypoint.sh,
// pg_setup_hba_conf), so a trust rule appears exactly when the environment asks for one.
//   crash        the image's entrypoint dies (the wrapper survives and runs its EXIT trap);
//   killwrapper  the WRAPPER is killed with SIGKILL (no trap), after the container's tmpfs was cleared by the kill.
const STUB = [
	"#!/bin/bash",
	'echo "INVOKED $*" >> "$STUB_LOG"',
	'echo "SERVICEFILE ${PGSERVICEFILE:-none}" >> "$STUB_LOG"',
	'echo "PGSERVICE ${PGSERVICE:-none}" >> "$STUB_LOG"',
	'echo "PASSFILE ${PGPASSFILE:-none}" >> "$STUB_LOG"',
	'echo "HOSTAUTH ${POSTGRES_HOST_AUTH_METHOD:-unset}" >> "$STUB_LOG"',
	'echo "PLACEHOLDER ${POSTGRES_PASSWORD:+set}" >> "$STUB_LOG"',
	'echo "INITDIR ${AF_INIT_DIR:-none}" >> "$STUB_LOG"',
	'if [ -n "${PGSERVICEFILE:-}" ] && [ -e "$PGSERVICEFILE" ]; then',
	'  echo SERVICEFILE_EXISTS >> "$STUB_LOG"',
	'  grep -qxF "password=$(cat /run/secrets/af_bootstrap)" "$PGSERVICEFILE" && echo SERVICEFILE_HOLDS_SECRET >> "$STUB_LOG"',
	'  echo "SERVICEFILE_MODE $(stat -c %a "$PGSERVICEFILE")" >> "$STUB_LOG"',
	'  echo "SERVICEFILE_OWNER $(stat -c %U "$PGSERVICEFILE")" >> "$STUB_LOG"',
	'  [ "$POSTGRES_PASSWORD" != "$(cat /run/secrets/af_bootstrap)" ] && echo PLACEHOLDER_IS_NOT_THE_SECRET >> "$STUB_LOG"',
	"fi",
	'if [ "$STUB_MODE" = crash ] || [ "$STUB_MODE" = killwrapper ]; then',
	'  mkdir -p "$PGDATA"',
	'  echo 16 > "$PGDATA/PG_VERSION"',
	"  printf 'local all all scram-sha-256\\nhost all all all %s\\n' \"${POSTGRES_HOST_AUTH_METHOD:-scram-sha-256}\" > \"$PGDATA/pg_hba.conf\"",
	"fi",
	'if [ "$STUB_MODE" = killwrapper ]; then',
	// The kill of the wrapper discards the container's tmpfs files in real life (a container stop); here the init
	// directory is emptied by hand so the shared container is left clean, then the wrapper dies without its trap.
	'  rm -f "$AF_INIT_DIR"/* && rmdir "$AF_INIT_DIR"',
	"  kill -KILL $PPID",
	"fi",
	'if [ "$STUB_MODE" = crash ]; then kill -KILL $$; fi',
	"exit 0",
	"",
].join("\n");

// A psql that stands in for the real one in a healthcheck run: it records the passfile it was given and then kills its
// parent shell with SIGKILL, which is what docker does to a check that runs past its timeout (no trap runs). It refuses
// to kill anything that is not a plain sh.
const STUB_PSQL = [
	"#!/bin/sh",
	'echo "$PGPASSFILE" >> "$STUB_LOG"',
	'[ "$(cat /proc/$PPID/comm)" = sh ] || { echo "parent is not sh" >> "$STUB_LOG.err"; exit 99; }',
	"kill -KILL $PPID",
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
		await runChecked("docker", ["exec", "-i", "-u", "root", container, "sh", "-c", `cat > ${dir}/bin/psql && chmod +x ${dir}/bin/psql`], { input: STUB_PSQL });
	});
	after(async () => {
		try {
			// Only what this file made, entry by entry; rmdir fails (loudly) on a directory with anything foreign inside.
			const own = ["bin/docker-entrypoint.sh", "bin/psql", "health-log", "health-log.err"];
			for (let n = 1; n <= counter; n++) own.push(`data-${n}/PG_VERSION`, `data-${n}/pg_hba.conf`, `data-${n}/${MARKER}`, `log-${n}`);
			const dirs = ["bin", ...Array.from({ length: counter }, (_, i) => `data-${i + 1}`)];
			if (container) await sh(`cd ${dir} && rm -f ${own.join(" ")} && for d in ${dirs.join(" ")}; do if [ -d "$d" ]; then rmdir "$d" || exit 1; fi; done && cd / && rmdir ${dir}`);
		} finally {
			await stack?.dispose();
		}
	});

	// A data directory of its own for one scenario and the wrapper run against it.
	const scenario = async (mode: "crash" | "killwrapper" | "ok", prepare = ""): Promise<{ data: string; log: string; result: Awaited<ReturnType<typeof exec>> }> => {
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

	it("the container's environment asks the image for no trust method and holds no password", async () => {
		const env = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .Config.Env}}", container])) as string[];
		assert.deepEqual(env.filter((entry) => /^POSTGRES_(HOST_AUTH_METHOD|PASSWORD)=/.test(entry)), []);
	});

	it("an initialisation that dies halfway leaves no service file, no init directory and no trust rule", async () => {
		const { data, log, result } = await scenario("crash");
		assert.notEqual(result.code, 0);
		const seen = await read(log);
		assert.match(seen, /^SERVICEFILE_EXISTS$/m, "the stub did not see a service file, so the test would pass vacuously");
		const serviceFile = /^SERVICEFILE (\S+)$/m.exec(seen)?.[1] ?? "none";
		assert.notEqual(serviceFile, "none");
		assert.equal(await exists(serviceFile), false, "the service file is still there");
		const initDir = /^INITDIR (\S+)$/m.exec(seen)?.[1] ?? "none";
		assert.notEqual(initDir, "none");
		assert.equal(await exists(initDir), false, "the init directory is still there");
		const found = (await exec("find", "/dev/shm", "-name", "af-init.*")).stdout.trim();
		assert.equal(found.split("\n").includes(initDir), false);
		assert.doesNotMatch(await read(`${data}/pg_hba.conf`), TRUST);
		assert.equal(await exists(`${data}/${MARKER}`), false);
	});

	it("the image is started with the bootstrap password in a 0600 service file of the server user, and with no trust method", async () => {
		const { log } = await scenario("crash");
		const seen = await read(log);
		assert.match(seen, /^SERVICEFILE_HOLDS_SECRET$/m);
		assert.match(seen, /^SERVICEFILE_MODE 600$/m);
		assert.match(seen, /^SERVICEFILE_OWNER postgres$/m);
		assert.match(seen, /^PGSERVICE \S+$/m);
		assert.match(seen, /^PASSFILE none$/m);
		assert.match(seen, /^HOSTAUTH unset$/m);
		// The image insists on a non-empty POSTGRES_PASSWORD; it gets a constant that is not the secret, and the service
		// file (which libpq prefers to the password variables) carries the real one.
		assert.match(seen, /^PLACEHOLDER set$/m);
		assert.match(seen, /^PLACEHOLDER_IS_NOT_THE_SECRET$/m);
	});

	it("a SIGKILL of the wrapper itself, after the image wrote its pg_hba.conf, leaves no trust rule in the volume", async () => {
		const { data, log, result } = await scenario("killwrapper");
		assert.notEqual(result.code, 0);
		assert.match(await read(log), /^INVOKED postgres$/m, "the stub did not run, so the test would pass vacuously");
		const hba = await read(`${data}/pg_hba.conf`);
		assert.match(hba, /^host all all all scram-sha-256$/m, "the stub did not write the image's pg_hba.conf");
		assert.doesNotMatch(hba, TRUST);
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

	it("the refusal rewrites nothing in the data directory, whatever its pg_hba.conf holds", async () => {
		// Whatever is in the file (the wrapper never edits one: a trust rule found there is the owner's to judge).
		for (const rule of ["scram-sha-256", "trust"]) {
			const prepare = `mkdir -p $D && echo 16 > $D/PG_VERSION && printf 'local all all scram-sha-256\\nhost all all all ${rule}\\n' > $D/pg_hba.conf && touch -d '2001-02-03 04:05:06' $D/pg_hba.conf`;
			const { data, result } = await scenario("ok", prepare);
			assert.notEqual(result.code, 0);
			// A rewrite (sed -i) would give the file a new modification time.
			assert.equal((await sh(`stat -c '%y' ${data}/pg_hba.conf`)).trim().slice(0, 19), "2001-02-03 04:05:06");
			assert.match(await read(`${data}/pg_hba.conf`), new RegExp(`^host all all all ${rule}$`, "m"));
		}
	});

	it("a data directory with the marker goes straight to the image's entrypoint and no service file is made", async () => {
		const { log, result } = await scenario("ok", `mkdir -p $D && echo 16 > $D/PG_VERSION && : > $D/${MARKER}`);
		assert.equal(result.code, 0, result.stderr);
		const seen = await read(log);
		assert.match(seen, /^INVOKED postgres$/m);
		assert.match(seen, /^SERVICEFILE none$/m);
		assert.match(seen, /^PASSFILE none$/m);
		assert.match(seen, /^INITDIR none$/m);
	});

	it("every start, a completed data directory's included, writes the one fixed 0600 passfile of the healthcheck", async () => {
		await scenario("ok", `mkdir -p $D && echo 16 > $D/PG_VERSION && : > $D/${MARKER}`);
		assert.equal((await sh(`stat -c '%a %U' ${HEALTH_PASSFILE}`)).trim(), "600 root");
		const line = (await sh(`cat ${HEALTH_PASSFILE}`)).trim();
		const secret = (await sh("cat /run/secrets/af_backup")).trim();
		assert.equal(line, `*:*:*:af_backup:${secret}`);
		assert.equal(await exists(`${HEALTH_PASSFILE}.new`), false, "the temporary file of the write is left");
	});

	const healthcheckCommand = async (): Promise<string> => {
		const test = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .Config.Healthcheck.Test}}", container])) as string[];
		assert.equal(test[0], "CMD-SHELL");
		return test[1] as string;
	};

	it("the healthcheck needs the marker and a real login, not only a server that answers", async () => {
		const command = await healthcheckCommand();
		assert.ok(command.includes(MARKER), "the healthcheck does not look at the marker");
		assert.match(command, /\bpsql\b/);
		assert.ok(command.includes(HEALTH_PASSFILE), "the healthcheck does not use the fixed passfile");
		assert.doesNotMatch(command, /PASSWORD/i);
		const good = await exec("sh", "-c", command);
		assert.equal(good.code, 0, good.stderr);
		const withoutMarker = await exec("sh", "-c", command.replaceAll(MARKER, ".af-init-never-made"));
		assert.notEqual(withoutMarker.code, 0);
	});

	it("a healthcheck that docker kills on its timeout leaves no passfile behind: the path is one fixed file, never a new one", async () => {
		// The check makes no file of its own (no mktemp, no trap that a SIGKILL would skip).
		const command = await healthcheckCommand();
		assert.doesNotMatch(command, /mktemp|trap /);
		const log = `${dir}/health-log`;
		for (let run = 0; run < 3; run++) {
			// The stub psql kills the check's shell the way docker's timeout does; the result code is not the point.
			await exec("env", `STUB_LOG=${log}`, "sh", "-c", `PATH=${dir}/bin:$PATH; sh -c "$1"; true`, "_", command);
		}
		assert.equal(await exists(`${log}.err`), false, `the stub psql could not kill the check: ${await read(`${log}.err`)}`);
		const seen = (await read(log)).trim().split("\n");
		assert.deepEqual(seen, [HEALTH_PASSFILE, HEALTH_PASSFILE, HEALTH_PASSFILE], "the stub psql was not reached three times, or the passfile differs per run");
		assert.equal((await sh(`stat -c %a ${HEALTH_PASSFILE}`)).trim(), "600");
		assert.match((await sh(`cat ${HEALTH_PASSFILE}`)).trim(), /^\*:\*:\*:af_backup:\S+$/);
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
