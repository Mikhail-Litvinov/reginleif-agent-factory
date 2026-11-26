// First start of the server on an empty volume: the bootstrap password (and every other secret) is never in the
// environment or the command line of any process of the container, at any moment of the initialisation, and nothing of
// the initialisation's own access is left behind (no passfile, no trust rule on the volume).
//
// How it is observed. Two samplers run inside the container from the moment the container starts, one as root and one as
// the postgres user (a process of another user is readable only with CAP_SYS_PTRACE, which a container does not have:
// measured, root alone read nothing of the postgres user's processes). Each sweeps /proc/<pid>/environ and
// /proc/<pid>/cmdline of every process again and again until the stack is healthy. A sampler holds the passwords in
// shell variables (not exported, never in its own arguments), so it puts none in any process data itself. It also records
// which processes it met and read: a clean result only counts when the initialisation steps (initdb, the temporary and
// the final server, the psql calls) were really read and every secret was loaded, so the test cannot pass by sampling
// nothing.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findContainer, freePort, ownedComposeArgs, ownedResources, run, runChecked, stackEnv, waitHealthy } from "../deploy/lib.ts";
import { SECRET_NAMES } from "../deploy/setup-secrets.ts";
import { Cleanups, newSecretsDir, trackedProject } from "./helpers.ts";

const STOP = "/tmp/af-sampler.stop";
const outFile = (user: string): string => `/tmp/af-sampler.${user}.out`;
const USERS = ["root", "postgres"] as const;

// 20 ms between sweeps: short enough to meet a psql call (tens of milliseconds, measured on the first start of the
// image), and it keeps the sampler from taking a whole core from the initialisation it watches.
const SAMPLER = [
	"#!/bin/bash",
	'out=/tmp/af-sampler.$1.out',
	`stop=${STOP}`,
	"passwords=()",
	'for f in /run/secrets/*; do v=$(<"$f") && passwords+=("$v"); done',
	"declare -A seen",
	': > "$out"',
	'echo "PASSWORDS ${#passwords[@]}" >> "$out"',
	"sweep() {",
	"  local p pid comm kind v pw key got",
	"  for p in /proc/[0-9]*; do",
	'    pid=${p#/proc/}',
	'    [ "$pid" = "$$" ] && continue',
	"    comm=",
	'    { read -r comm < "$p/comm"; } 2>/dev/null || true',
	'    [ -n "$comm" ] || continue',
	'    key="$pid:$comm"',
	'    if [ -z "${seen[S$key]:-}" ]; then seen[S$key]=1; echo "SEEN $comm" >> "$out"; fi',
	"    for kind in environ cmdline; do",
	"      got=",
	"      while IFS= read -r -d '' v; do",
	"        got=1",
	'        for pw in "${passwords[@]}"; do',
	'          [ -n "$pw" ] || continue',
	'          case $v in *"$pw"*) echo "LEAK $kind $pid $comm" >> "$out" ;; esac',
	"        done",
	'      done 2>/dev/null < "$p/$kind"',
	'      if [ -n "$got" ] && [ -z "${seen[R$kind$key]:-}" ]; then seen[R$kind$key]=1; echo "READ $kind $comm" >> "$out"; fi',
	"    done",
	"  done",
	"}",
	'while [ ! -e "$stop" ]; do sweep; sleep 0.02; done',
	"sweep",
	'echo DONE >> "$out"',
	"",
].join("\n");

describe("first start", () => {
	const cleanups = new Cleanups();
	let container = "";
	const reports = new Map<string, string[]>();

	before(async () => {
		const scratch = await mkdtemp(join(tmpdir(), "af-test-sampler-"));
		cleanups.add(() => rm(scratch, { recursive: true, force: true }));
		const secretsDir = await newSecretsDir(cleanups);
		const port = await freePort();
		const { project, runId } = trackedProject(cleanups);
		const env = stackEnv({ project, secretsDir, port, runId });

		// The container is created first, the samplers are copied into it, and only then does the server start.
		await runChecked("docker", ownedComposeArgs(project, runId, "create"), { env });
		const created = (await ownedResources(runId)).containers;
		assert.equal(created.length, 1);
		container = created[0] as string;
		const script = join(scratch, "sampler.sh");
		await writeFile(script, SAMPLER);
		await runChecked("docker", ["cp", script, `${container}:/tmp/sampler.sh`]);
		await runChecked("docker", ["start", container]);
		for (const user of USERS) await runChecked("docker", ["exec", "-d", "-u", user, container, "bash", "/tmp/sampler.sh", user]);

		await waitHealthy(await findContainer(project));
		await runChecked("docker", ["exec", "-u", "root", container, "touch", STOP]);
		// Wait inside the container until each sampler wrote its last line (bounded by timeout, no wait on this side).
		for (const user of USERS) {
			await runChecked("docker", ["exec", "-u", "root", container, "timeout", "60", "sh", "-c", `until grep -q '^DONE' ${outFile(user)}; do sleep 0.05; done`]);
			const text = await runChecked("docker", ["exec", "-u", "root", container, "cat", outFile(user)]);
			reports.set(user, text.split(/\r?\n/).filter(Boolean));
		}
	});
	after(async () => {
		await cleanups.runAll();
	});

	const exec = async (...command: string[]): Promise<string> => runChecked("docker", ["exec", "-u", "root", container, ...command]);
	const lines = (prefix: string): string[] => USERS.flatMap((user) => (reports.get(user) ?? []).filter((line) => line.startsWith(prefix)));

	it("the samplers loaded every secret and really read the processes of the initialisation (a clean result is not vacuous)", () => {
		for (const user of USERS) assert.ok((reports.get(user) ?? []).includes(`PASSWORDS ${SECRET_NAMES.length}`), `the ${user} sampler did not load all ${SECRET_NAMES.length} secrets`);
		const read = new Set(lines("READ environ ").map((line) => line.slice("READ environ ".length)));
		for (const name of ["initdb", "postgres", "psql"]) assert.ok(read.has(name), `no ${name} process had its environment read; read: ${[...read].join(", ")}`);
		for (const user of USERS) assert.equal((reports.get(user) ?? []).at(-1), "DONE");
	});

	it("no password of any account is in the environment or command line of any process during the first start", () => {
		assert.deepEqual(lines("LEAK "), []);
	});

	it("the container has a secret for each account the samplers looked for", async () => {
		assert.equal((await exec("sh", "-c", "ls /run/secrets | sort")).trim().split("\n").join(","), [...SECRET_NAMES].sort().join(","));
	});

	it("the bootstrap passfile is gone after the initialisation", async () => {
		assert.equal((await exec("find", "/dev/shm", "-name", "pgpass.*")).trim(), "");
	});

	it("no trust rule is left in the data directory's pg_hba.conf", async () => {
		const hba = await exec("cat", "/var/lib/postgresql/data/pg_hba.conf");
		assert.doesNotMatch(hba, /^\s*(local|host\w*)\s.*\strust\s*$/m);
		assert.doesNotMatch(hba, /auth-trust/);
	});

	it("the environment of the container lists no password variable, only the file reference of the initdb option", async () => {
		const env = (await run("docker", ["inspect", "--format", "{{json .Config.Env}}", container])).stdout;
		assert.equal(/POSTGRES_PASSWORD/.test(env), false, "POSTGRES_PASSWORD or POSTGRES_PASSWORD_FILE is still set");
		assert.match(env, /--pwfile=\/run\/secrets\/af_bootstrap/);
	});
});
