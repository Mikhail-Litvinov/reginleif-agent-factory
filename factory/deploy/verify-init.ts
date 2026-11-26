// Checks that a RUNNING database of this stack is completely initialised: every statement of init/10-roles.sh and every
// step of init/99-finish.sh left its result (the list is deploy/init-postconditions.ts, which a test keeps equal to the
// init scripts). It only reads. Used before marking a database that was made before the marker existed
// (docs/agent-factory/deployment.md "A start that refuses"): the marker is created only when every check passes.
//
//   node deploy/verify-init.ts [--project agent-factory] [--with-marker]
//
// Prints one line per check, `ok   <name>` or `FAIL <name>: <detail>`, and exits 0 when all pass, 1 when any fails, 2 on a
// wrong argument. --with-marker adds the check that the marker .af-init-complete exists (a database not yet marked fails
// that one by definition, so it is asked for only after marking).
import { APPLICATION_ROLES, BOOTSTRAP_ROLE, CHECKS, HBA_RULES_SQL, hbaRuleProblems, type Check, type HbaRule, type SqlCheck } from "./init-postconditions.ts";
import { DATABASE, findContainer, run, tryPsql } from "./lib.ts";

export interface CheckResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export interface VerifyOptions {
	readonly project?: string;
	// The container to check; found from the project when absent.
	readonly container?: string;
	readonly withMarker?: boolean;
}

// The role whose login runs the catalog checks: the one the healthcheck uses anyway, with no rights beyond reading.
const CHECKING_ROLE = "af_backup";

const batchSql = (checks: readonly SqlCheck[]): string =>
	checks.map((check, index) => `select '${index}|' || coalesce((${check.expression})::text, 'false');`).join("\n") + "\n";

const failure = (check: Check, detail: string): CheckResult => ({ name: check.name, ok: false, detail });
const success = (check: Check): CheckResult => ({ name: check.name, ok: true, detail: "" });
const firstLine = (text: string, fallback: string): string => (text.trim() || fallback).split(/\r?\n/)[0] as string;

export interface ServerOptions {
	// A server other than the stack's own on this port (tests only: a scratch server in the same container).
	readonly port?: number;
	readonly database?: string;
}

// The problems of the rules the server really uses. Read as the bootstrap role over the socket (the only way that role may
// connect), from pg_hba_file_rules, so the file named by the server's hba_file is the one judged, not the data directory's.
export const checkActiveHba = async (container: string, options: ServerOptions = {}): Promise<string[]> => {
	const read = await tryPsql(container, BOOTSTRAP_ROLE, HBA_RULES_SQL, { database: "postgres", port: options.port });
	if (read.code !== 0) return [`could not read the active rules: ${firstLine(read.stderr || read.stdout, `exit ${read.code}`)}`];
	let parsed: { file: string; rules: HbaRule[] };
	try {
		parsed = JSON.parse(read.stdout.trim()) as { file: string; rules: HbaRule[] };
	} catch {
		return [`could not read the active rules: unexpected answer ${firstLine(read.stdout, "(empty)")}`];
	}
	return hbaRuleProblems(parsed.rules).map((problem) => `${problem} (active file ${parsed.file})`);
};

// One login over TCP with a password that is in no secret file. null when the server refuses it, as it must; the problem
// when it lets the login in (a rule that does not ask for the password is active) or fails for another reason.
export const probeWrongPassword = async (container: string, role: string, options: ServerOptions = {}): Promise<string | null> => {
	const attempt = await tryPsql(container, role, "select 1;", { database: options.database ?? DATABASE, tcp: true, port: options.port, wrongPassword: true });
	if (attempt.code === 0) return `the server accepted a login as ${role} with a password that is not in its secret file: an active rule does not ask for the password`;
	if (/password authentication failed/i.test(attempt.stderr)) return null;
	return `the login as ${role} with a wrong password failed, but not for the password: ${firstLine(attempt.stderr, `exit ${attempt.code}`)}`;
};

export const verifyInit = async (options: VerifyOptions = {}): Promise<CheckResult[]> => {
	const container = options.container ?? (await findContainer(options.project ?? "agent-factory"));
	const checks = CHECKS.filter((check) => !(check.kind === "shell" && check.isMarker && !options.withMarker));
	const sqlChecks = checks.filter((check): check is SqlCheck => check.kind === "sql");

	// All catalog checks in one session; the answer is one line per check. A failing session (the role cannot log in, the
	// database is gone) fails every one of them with the server's words, never a pass.
	const runBatch = async (): Promise<{ verdicts: Map<number, string>; sqlProblem: string }> => {
		const verdicts = new Map<number, string>();
		const batch = await tryPsql(container, CHECKING_ROLE, batchSql(sqlChecks), { database: DATABASE, tcp: true });
		if (batch.code !== 0) {
			return { verdicts, sqlProblem: `could not run the catalog checks as ${CHECKING_ROLE}: ${(batch.stderr.trim() || batch.stdout.trim() || `exit ${batch.code}`).split(/\r?\n/)[0]}` };
		}
		for (const line of batch.stdout.split(/\r?\n/)) {
			const match = /^(\d+)\|(.*)$/.exec(line.trim());
			if (match) verdicts.set(Number(match[1]), match[2] as string);
		}
		return { verdicts, sqlProblem: "" };
	};
	const batchResult = runBatch();

	// The catalog batch, the logins, the rule check and the shell checks are independent reads (one docker exec each), so
	// they run together; the results keep the order of CHECKS.
	const resultOf = async (check: Check): Promise<CheckResult> => {
		if (check.kind === "sql") {
			const { verdicts, sqlProblem } = await batchResult;
			const index = sqlChecks.indexOf(check);
			const verdict = verdicts.get(index);
			return sqlProblem ? failure(check, sqlProblem) : verdict === "true" ? success(check) : failure(check, verdict === undefined ? "no answer" : "the postcondition does not hold");
		}
		if (check.kind === "hba") {
			const problems = await checkActiveHba(container);
			return problems.length === 0 ? success(check) : failure(check, problems.join("; "));
		}
		if (check.kind === "login" && check.wrongPassword) {
			const problem = await probeWrongPassword(container, check.role);
			return problem === null ? success(check) : failure(check, problem);
		}
		if (check.kind === "login") {
			const attempt = await tryPsql(container, check.role, "select 1;", { database: DATABASE, tcp: true });
			return attempt.code === 0 && attempt.stdout.trim() === "1" ? success(check) : failure(check, (attempt.stderr.trim() || `exit ${attempt.code}`).split(/\r?\n/)[0] as string);
		}
		const attempt = await run("docker", ["exec", "-u", "postgres", container, "sh", "-c", check.script]);
		return attempt.code === 0 ? success(check) : failure(check, (attempt.stdout.trim() || attempt.stderr.trim() || `exit ${attempt.code}`).split(/\r?\n/)[0] as string);
	};
	return Promise.all(checks.map(resultOf));
};

export const formatResults = (results: readonly CheckResult[]): string[] =>
	results.map((result) => (result.ok ? `ok   ${result.name}` : `FAIL ${result.name}: ${result.detail}`));

const parseArgs = (argv: string[]): VerifyOptions => {
	let project = "agent-factory";
	let withMarker = false;
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--project") {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new UsageError("--project needs a project name");
			project = value;
		} else if (flag === "--with-marker") withMarker = true;
		else throw new UsageError(`unknown argument: ${flag}`);
	}
	return { project, withMarker };
};

class UsageError extends Error {}

if (import.meta.main) {
	try {
		const results = await verifyInit(parseArgs(process.argv.slice(2)));
		for (const line of formatResults(results)) console.log(line);
		const failed = results.filter((result) => !result.ok).length;
		if (failed > 0) {
			console.error(`${failed} of ${results.length} checks failed: this database is not completely initialised; do not mark it, restore from a known-good backup.`);
			process.exitCode = 1;
		} else {
			console.log(`all ${results.length} checks passed (${APPLICATION_ROLES.length} application roles).`);
		}
	} catch (error) {
		console.error(`verify-init failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error("usage: node deploy/verify-init.ts [--project agent-factory] [--with-marker]");
		process.exitCode = error instanceof UsageError ? 2 : 1;
	}
}
