// Shared helpers of the deploy scripts and their tests: running processes, talking to the database container, and the
// catalog queries that the backup and the restore check both use (so that both sides count the same way).
//
// A password never travels on a command line and never sits in a process environment (`docker inspect`, `ps`, a core
// dump or a child process would all show an environment variable). A command inside the container writes a passfile
// from the account's secret file into tmpfs (/dev/shm, memory only) with mode 0600, names it by PGPASSFILE (a path, not
// a secret), and removes it when the command ends, also on a signal.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export const DATABASE = "agent_factory";
export const COMPOSE_FILE = new URL("./compose.yml", import.meta.url);
const ROLE_NAME = /^[a-z_]+$/;

export interface RunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunOptions {
	readonly input?: string | Buffer;
	readonly env?: Record<string, string | undefined>;
	readonly cwd?: string;
}

// Runs a program to its end and returns its output; a missing program rejects, a non-zero exit does not.
export const run = (command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
	new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { env: { ...process.env, ...options.env }, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	});

// Like run, but a non-zero exit throws with the program's error text.
export const runChecked = async (command: string, args: readonly string[], options: RunOptions = {}): Promise<string> => {
	const result = await run(command, args, options);
	if (result.code !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout;
};

// The shell script that runs `program` with a passfile of `role`. printf is a shell builtin, so the password is in no
// argument list; the program runs as a child (not exec) so that the trap can remove the passfile afterwards, and the
// script ends with the program's exit status.
export const passfileScript = (role: string, program: string): string => {
	if (!ROLE_NAME.test(role)) throw new Error(`bad role name: ${role}`);
	return [
		"umask 077",
		"f=$(mktemp /dev/shm/pgpass.XXXXXX) || exit 1",
		`trap 'rm -f "$f"' EXIT`,
		"trap 'exit 1' INT TERM",
		`printf '*:*:*:${role}:%s\\n' "$(cat /run/secrets/${role})" > "$f"`,
		`PGPASSFILE="$f" ${program}`,
	].join("; ");
};

// The argument list that runs `program` inside the container with the role's password taken from its secret file.
export const execArgs = (container: string, role: string, program: string): string[] => [
	"exec", "-i", container, "sh", "-c", passfileScript(role, program),
];

export interface PsqlOptions {
	readonly database?: string;
	// Connect over TCP (127.0.0.1 inside the container) instead of the unix socket.
	readonly tcp?: boolean;
}

const psqlProgram = (role: string, options: PsqlOptions): string =>
	`psql -X -q -At -w -v ON_ERROR_STOP=1 ${options.tcp ? "-h 127.0.0.1 " : ""}-U ${role} -d ${options.database ?? DATABASE}`;

// Runs SQL (from standard input) as `role`; resolves with the result, rejects on an error.
export const psql = async (container: string, role: string, sql: string, options: PsqlOptions = {}): Promise<string> =>
	(await runChecked("docker", execArgs(container, role, psqlProgram(role, options)), { input: sql })).trim();

// Same, but returns the result without throwing, for tests that expect a refusal.
export const tryPsql = (container: string, role: string, sql: string, options: PsqlOptions = {}): Promise<RunResult> =>
	run("docker", execArgs(container, role, psqlProgram(role, options)), { input: sql });

// A psql session that stays open: statements go in one at a time, each answering with exactly one line.
export class PsqlSession {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly lines: string[] = [];
	private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
	private pending = "";
	private stderr = "";
	private closed: Error | null = null;
	private readonly exited: Promise<number | null>;

	constructor(container: string, role: string, options: PsqlOptions = {}) {
		this.child = spawn("docker", execArgs(container, role, psqlProgram(role, options)), { stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdin.on("error", () => {});
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.pending += chunk.toString("utf8");
			let newline = this.pending.indexOf("\n");
			while (newline >= 0) {
				this.deliver(this.pending.slice(0, newline).replace(/\r$/, ""));
				this.pending = this.pending.slice(newline + 1);
				newline = this.pending.indexOf("\n");
			}
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
		});
		this.exited = new Promise((resolvePromise) => {
			this.child.on("close", (code) => {
				this.closed = new Error(`psql session ended (exit ${code}): ${this.stderr.trim()}`);
				for (const waiter of this.waiters.splice(0)) waiter.reject(this.closed);
				resolvePromise(code);
			});
		});
	}

	private deliver(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(line);
		else this.lines.push(line);
	}

	private nextLine(): Promise<string> {
		const queued = this.lines.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.closed) return Promise.reject(this.closed);
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	// Sends one statement that prints exactly one line and returns that line.
	query(sql: string): Promise<string> {
		const answer = this.nextLine();
		this.child.stdin.write(`${sql}\n`);
		return answer;
	}

	// Sends a statement that prints nothing.
	execute(sql: string): void {
		this.child.stdin.write(`${sql}\n`);
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		await this.exited;
	}
}

// The tables that hold data: ordinary and partitioned tables outside the system schemas and outside extensions.
// One line of JSON: { "schema.table": rowCount }. Run inside one snapshot it is consistent with a dump taken on it.
export const ROW_COUNTS_SQL = [
	"select coalesce(jsonb_object_agg(n.nspname || '.' || c.relname,",
	"(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint",
	"order by n.nspname, c.relname), '{}'::jsonb)",
	"from pg_class c join pg_namespace n on n.oid = c.relnamespace",
	"where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'",
	"and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');",
].join(" ");

export interface ForeignKey {
	readonly table: string;
	readonly name: string;
	readonly definition: string;
	readonly validated: boolean;
}

// One line of JSON: every foreign key with its definition and whether it is validated.
export const FOREIGN_KEYS_SQL =
	"select coalesce(jsonb_agg(jsonb_build_object('table', conrelid::regclass::text, 'name', conname, 'definition', pg_get_constraintdef(oid), 'validated', convalidated) order by conrelid::regclass::text, conname), '[]'::jsonb) from pg_constraint where contype = 'f';";

// A free TCP port on the loopback address (the small gap between closing it here and using it is the caller's risk).
export const freePort = (): Promise<number> =>
	new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePromise(port));
		});
	});

export const composeFilePath = (): string => decodeURIComponent(COMPOSE_FILE.pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export const composeArgs = (project: string, ...rest: string[]): string[] => ["compose", "-p", project, "-f", composeFilePath(), ...rest];

const runLabelFilePath = (): string => decodeURIComponent(new URL("./compose.run.yml", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// Same, for a project that a command created itself: a second compose file puts the label af.run=<runId> on its
// container, volume and network, so that removal can select exactly what this run created.
export const ownedComposeArgs = (project: string, runId: string, ...rest: string[]): string[] => [
	"compose", "-p", project, "-f", composeFilePath(), "-f", runLabelFilePath(), ...rest,
];

export const RUN_LABEL = "af.run";
const RUN_ID = /^[0-9a-f]{12}$/;

const assertRunId = (runId: string): void => {
	if (!RUN_ID.test(runId)) throw new Error(`bad run id: ${runId}`);
};

export const newRunId = (): string => randomBytes(6).toString("hex");

// Time as a dependency: a test injects a clock whose sleep only moves its own now, so no test waits on a wall clock.
export interface Clock {
	now(): number;
	sleep(milliseconds: number): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
};

export type HealthInspect = (container: string) => Promise<RunResult>;

const inspectHealth: HealthInspect = (container) => run("docker", ["inspect", "--format", "{{.State.Health.Status}}", container]);

export interface WaitDeps {
	readonly clock?: Clock;
	readonly inspect?: HealthInspect;
}

// Polls the container's healthcheck until it reports healthy; gives up at the deadline. A poll on a state, not a sleep
// that guesses a duration: the healthcheck turns healthy only after init finished and the final server accepts logins.
export const waitHealthy = async (container: string, timeoutMs = 180_000, deps: WaitDeps = {}): Promise<void> => {
	const clock = deps.clock ?? realClock;
	const inspect = deps.inspect ?? inspectHealth;
	const deadline = clock.now() + timeoutMs;
	let status = "";
	while (clock.now() < deadline) {
		const result = await inspect(container);
		status = result.stdout.trim();
		if (status === "healthy") return;
		if (result.code !== 0) throw new Error(`container ${container} is gone: ${result.stderr.trim()}`);
		await clock.sleep(300);
	}
	throw new Error(`container ${container} not healthy after ${timeoutMs} ms (last status: ${status})`);
};

export interface StackOptions {
	readonly project: string;
	readonly secretsDir: string;
	readonly port: number;
	// The run that owns the project: every resource it creates carries the label af.run=<runId>.
	readonly runId: string;
}

export const stackEnv = (options: StackOptions): Record<string, string> => ({
	AF_SECRETS_DIR: options.secretsDir,
	AF_PG_PORT: String(options.port),
	AF_RUN_ID: options.runId,
});

// The compose command line of a stack that a run owns.
export const stackArgs = (options: StackOptions, ...rest: string[]): string[] => ownedComposeArgs(options.project, options.runId, ...rest);

// Starts a compose project of the server and waits until it is healthy; returns the container id.
export const startStack = async (options: StackOptions): Promise<string> => {
	assertRunId(options.runId);
	await runChecked("docker", stackArgs(options, "up", "-d"), { env: stackEnv(options) });
	const container = await findContainer(options.project);
	await waitHealthy(container);
	return container;
};

export interface OwnedResources {
	readonly containers: string[];
	readonly networks: string[];
	readonly volumes: string[];
}

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

// What carries this run's label. Each listing must succeed: a failed listing throws, it never reads as "nothing".
export const ownedResources = async (runId: string): Promise<OwnedResources> => {
	assertRunId(runId);
	const filter = `label=${RUN_LABEL}=${runId}`;
	return {
		containers: lines(await runChecked("docker", ["ps", "-a", "-q", "--no-trunc", "--filter", filter])),
		networks: lines(await runChecked("docker", ["network", "ls", "-q", "--no-trunc", "--filter", filter])),
		volumes: lines(await runChecked("docker", ["volume", "ls", "-q", "--filter", filter])),
	};
};

// Removes exactly what carries this run's label (containers with their anonymous volumes, then networks, then volumes).
// Every command's exit code is checked; failures are collected and thrown together, after all steps were tried.
//
// This is the only place of the package that removes docker resources (tests/removal-guard.test.ts fails when any other
// file does): a removal is always selected by the run's own label, never by a project name or a name pattern, so it
// cannot reach anything this run did not create. `keepVolumes` leaves the labelled volumes in place (a stack that is taken
// down and brought up again on the same data); the final check then ignores them.
export const removeOwned = async (runId: string, options: { keepVolumes?: boolean } = {}): Promise<void> => {
	const found = await ownedResources(runId);
	const errors: string[] = [];
	const step = async (args: string[], ids: string[]): Promise<void> => {
		if (ids.length === 0) return;
		const result = await run("docker", [...args, ...ids]);
		if (result.code !== 0) errors.push(`docker ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	};
	await step(["rm", "-f", "-v"], found.containers);
	await step(["network", "rm"], found.networks);
	if (!options.keepVolumes) await step(["volume", "rm"], found.volumes);
	if (errors.length > 0) throw new Error(errors.join("; "));
	const left = await ownedResources(runId);
	const count = left.containers.length + left.networks.length + (options.keepVolumes ? 0 : left.volumes.length);
	if (count > 0) throw new Error(`${count} resource(s) with label ${RUN_LABEL}=${runId} remain after removal`);
};

// Removes what a run created for its stack (by label, nothing else).
export const removeStack = (options: StackOptions): Promise<void> => removeOwned(options.runId);

// Whether anything of the given compose project name exists: containers (also stopped), volumes or networks, by the
// compose project label and by the name prefix `<project>_` / `<project>-`. A failed listing throws.
export const projectResourcesExist = async (project: string): Promise<string[]> => {
	const byLabel = `label=com.docker.compose.project=${project}`;
	const found: string[] = [];
	for (const name of lines(await runChecked("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", byLabel]))) found.push(`container ${name}`);
	for (const name of lines(await runChecked("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${project}-`]))) found.push(`container ${name}`);
	for (const name of lines(await runChecked("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", byLabel]))) found.push(`volume ${name}`);
	for (const name of lines(await runChecked("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${project}_`]))) found.push(`volume ${name}`);
	for (const name of lines(await runChecked("docker", ["network", "ls", "--format", "{{.Name}}", "--filter", byLabel]))) found.push(`network ${name}`);
	for (const name of lines(await runChecked("docker", ["network", "ls", "--format", "{{.Name}}", "--filter", `name=${project}_`]))) found.push(`network ${name}`);
	return [...new Set(found)];
};

// The id of the running server container of a compose project.
export const findContainer = async (project: string): Promise<string> => {
	const ids = (await runChecked("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=postgres"])).split(/\s+/).filter(Boolean);
	if (ids.length !== 1) throw new Error(`expected one running postgres container in project ${project}, found ${ids.length}`);
	return ids[0] as string;
};
