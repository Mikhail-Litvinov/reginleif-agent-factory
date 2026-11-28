// Creates the secrets directory of the Agent Factory database: one file with a random password per account.
//
//   node deploy/setup-secrets.ts <directory>          create what is missing, then verify the access
//   node deploy/setup-secrets.ts --check <directory>  verify readiness only (changes nothing): all seven files present and
//                                                     valid, access restricted, and the place cannot be committed
//   node deploy/setup-secrets.ts --check-access <directory>  only the access rule that backup.ts applies to its target
//                                                     (no secret file needed, the place is not judged); exit 1 when too wide
// A wrong command line exits 2 with the usage line.
//
// A file that exists is never overwritten (a changed password would lock the running database out). An existing file that
// holds no password the init script accepts (empty, or with other characters) is not "kept" either: the command refuses and
// names the file, and the owner removes that one file and runs the command again. Passwords are never printed. A new secret file is created EMPTY and exclusively, its own effective access (what it inherited from
// the directory included) is read back, and only then is the password written; a file that fails that check is removed
// empty, so no secret byte is ever written into a file whose protection was not verified.
//
// Access: on Windows the directory is restricted by ACL to the current user, SYSTEM and Administrators (well-known SIDs,
// so a localized system does not matter), and the ACL is READ BACK by SID for the directory and for every secret file;
// the result must hold only those three, with no other entry. Elsewhere the check is the mode: nothing for group or
// others. A directory that already holds anything (our secrets or unrelated files) is never restricted silently: when its
// access is wider than that, the command refuses and says which entry is the problem, and the owner decides. A directory
// that exists but is still empty
// (for example one just made by mkdtemp) has nothing to protect yet, so its access is set explicitly (inheritance off,
// every entry other than the three removed) and READ BACK before the first secret is written; when that verification
// fails, nothing is written.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SID_ADMINISTRATORS, SID_SYSTEM, aclSids, pathsAccessProblems, restrictDirectory } from "./acl.ts";
import { UsageError, parseCliArgs, reportCliFailure } from "./cli-args.ts";
import { idOfStats, sameId } from "./identity.ts";

// One secret per account; the first is the bootstrap superuser of the server (init and recovery only).
// af_temporal is the role of the Temporal databases (init/20-temporal.sh, deploy/bootstrap-temporal.ts).
export const SECRET_NAMES = ["af_bootstrap", "af_migrator", "af_api", "af_control", "af_backup", "af_reader", "af_temporal"] as const;

// 32 random bytes = 256 bits, base64url so that the text holds only A-Z a-z 0-9 _ - (the init script checks it).
const PASSWORD_BYTES = 32;

export { SID_ADMINISTRATORS, SID_SYSTEM, aclSids };

export interface SecretsResult {
	readonly directory: string;
	readonly created: string[];
	readonly kept: string[];
}

const secretFiles = (directory: string): string[] => SECRET_NAMES.map((n) => join(directory, n)).filter((f) => existsSync(f));

// What the init scripts accept as a password (init/lib/bootstrap.sh and init/lib/temporal.sql: the file's text without trailing newlines, non-empty,
// only A-Z a-z 0-9 _ -). A file that fails it would start a role with no usable password.
const VALID_PASSWORD = /^[A-Za-z0-9_-]+$/;

// The secret files that exist but hold no password the init script would accept (an empty file left by a kill between the
// exclusive create and the write, or a file with other content). The content is read and tested, never printed.
export const invalidSecretFiles = (directory: string): string[] => {
	const problems: string[] = [];
	for (const file of secretFiles(resolve(directory))) {
		const text = readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
		if (!VALID_PASSWORD.test(text)) {
			problems.push(
				`${file} is ${text === "" ? "empty" : "not a valid password (only A-Z a-z 0-9 _ - are allowed)"}; it was not changed; to recover, remove that one file, then run the command again: it creates a new password for that account only.`,
			);
		}
	}
	return problems;
};

// The access of the directory and of each secret file that exists; an empty list means exactly the allowed holders.
// Read-only: it changes nothing.
export const verifySecretsAccess = (directory: string): string[] => {
	const target = resolve(directory);
	if (!existsSync(target)) return [`${target} does not exist`];
	return pathsAccessProblems([target, ...secretFiles(target)]);
};

// ONLY the access rule that backup.ts applies to its target (pathsAccessProblems): the directory itself, no secret file
// required and the place not judged. For --check-access, which the documents use to test a backup directory.
export const directoryAccessProblems = (directory: string): string[] => {
	const target = resolve(directory);
	if (!existsSync(target)) return [`${target} does not exist`];
	if (!statSync(target).isDirectory()) return [`${target} is not a directory`];
	return pathsAccessProblems([target]);
};

// The nearest ancestor of `path` that is a git checkout (holds an entry named .git, a directory or the file of a linked
// worktree), or undefined. `path` is already resolved.
const checkoutRootOf = (path: string): string | undefined => {
	for (let dir = path; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
};

// `path` with every link on the way resolved: through its nearest existing ancestor, then the part that does not exist yet.
const resolveThroughLinks = (path: string): string => {
	const rest: string[] = [];
	let existing = resolve(path);
	while (!existsSync(existing) && dirname(existing) !== existing) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	return join(realpathSync.native(existing), ...rest);
};

// The location rule: a secret must not sit where a commit can take it. Judged on the RESOLVED path (a symlink or junction
// from outside into a checkout leads into it). A place inside a checkout is allowed only when git itself ignores it
// (`git check-ignore --no-index`: the rule of .gitignore files whether or not anything is tracked), and a failure to ask git
// counts as "not ignored". The exception exists because an ignored scratch folder inside a checkout (a project's .tmp) is
// a normal place for a test's secrets and can never be committed.
export const worktreeProblems = (paths: string[]): string[] => {
	const problems: string[] = [];
	for (const path of paths) {
		const resolved = resolveThroughLinks(path);
		const root = checkoutRootOf(resolved);
		if (root === undefined) continue;
		const inside = relative(root, resolved).split(sep).join("/") || ".";
		const asked = spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", inside], { encoding: "utf8" });
		if (asked.status === 0) continue;
		const why = asked.status === 1 ? "and not git-ignored: a secret there can be committed" : `and git could not say whether it is ignored (${asked.error?.message ?? (asked.stderr.trim() || `exit status ${asked.status}`)})`;
		problems.push(`${resolved} is inside the git checkout ${root} ${why}; keep the secrets directory outside any checkout`);
	}
	return problems;
};

// Everything that must hold before the stack may be started from `directory`: it exists, holds all seven secret files, each
// with a valid password, the access is exactly the allowed holders, and the place cannot be committed (worktreeProblems).
// The generic access check (verifySecretsAccess) stays what backup directories are verified with. Read-only; synchronous.
export const secretsReadiness = (directory: string): string[] => {
	const target = resolve(directory);
	if (!existsSync(target)) return [`${target} does not exist`];
	if (!statSync(target).isDirectory()) return [`${target} is not a directory`];
	const problems: string[] = [];
	for (const name of SECRET_NAMES) {
		if (!existsSync(join(target, name))) problems.push(`the secret file ${join(target, name)} is missing (the password of ${name})`);
	}
	problems.push(...verifySecretsAccess(target), ...invalidSecretFiles(target));
	const present = secretFiles(target);
	problems.push(...worktreeProblems(present.length > 0 ? present : [target]));
	return problems;
};

// The access of one secret file that was just created, before any secret byte is in it: the file's own effective
// ACL (what it inherited from the directory included) and the directory it sits in.
export const verifyFileAccess = (file: string): string[] => pathsAccessProblems([dirname(file), file]);

const restrict = (directory: string): void => restrictDirectory(directory, "secrets directory");

type Lock = (directory: string) => void;

const refuse = (target: string, problems: string[]): Error =>
	new Error(
		`refused: the secrets directory ${target} already exists and holds files, and its access is wider than allowed; it was not changed.\n` +
			problems.map((p) => `  - ${p}`).join("\n") +
			"\nRemove those entries yourself (for example icacls <path> /remove:g *<sid>) and run the command again.",
	);

// Removes `file` only while it is still the file with the recorded identity (identity.ts: device, inode and creation
// time all equal, and the inode known, since 0 means the filesystem gave none and two zeros prove nothing). A path that now holds
// something else, or nothing, or whose identity is not proven, is left as it is: a leftover empty file is harmless and
// is seen by the next run, a removed foreign file is not. Residual window: between this check and the unlink (same as
// owned.ts). `stat` is replaceable for the test that proves the rule on identities a real filesystem will not give.
export const removeIfSame = (file: string, made: BigIntStats, stat: (path: string) => BigIntStats = (p) => lstatSync(p, { bigint: true })): void => {
	let now: BigIntStats;
	try {
		now = stat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!sameId(idOfStats(now), idOfStats(made))) return;
	try {
		unlinkSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
};

// The order is the rule: no secret byte is written to a place whose protection was not verified first. A directory that
// holds secrets is verified and refused when it is too open; one that holds none is locked, then READ BACK, and only a
// verified directory gets files (they inherit its access, and are verified again after). `options.lock` replaces the
// locking step, for the test that proves nothing is written when the verification fails.
export const createSecrets = (directory: string, options: { lock?: Lock; verifyFile?: (file: string) => string[] } = {}): SecretsResult => {
	const target = resolve(directory);
	// Only a directory this run creates, or one that is truly empty, has its access changed. A directory that exists and
	// holds anything (our secrets, or files of somebody else) is verified and refused when too open, never modified.
	const reused = existsSync(target) && (secretFiles(target).length > 0 || readdirSync(target).length > 0);
	if (reused) {
		const problems = verifySecretsAccess(target);
		if (problems.length > 0) throw refuse(target, problems);
		// Before anything is created or reported as kept: an invalid file is never overwritten and never counted as present.
		const invalid = invalidSecretFiles(target);
		if (invalid.length > 0) throw new Error(`refused: the secrets directory ${target} holds a secret file that is not usable:\n${invalid.map((p) => `  - ${p}`).join("\n")}`);
	} else {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		(options.lock ?? restrict)(target);
		const problems = verifySecretsAccess(target);
		if (problems.length > 0) throw new Error(`the secrets directory ${target} is not restricted as required; nothing was written:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
	const created: string[] = [];
	const kept: string[] = [];
	for (const name of SECRET_NAMES) {
		const file = join(target, name);
		if (existsSync(file)) {
			kept.push(name);
			continue;
		}
		// The file is created empty ("wx" fails when it appeared meanwhile, so a race cannot overwrite either), its own
		// effective access is verified, and only then does the secret go in. A file that fails the check is removed empty.
		const fd = openSync(file, "wx", 0o600);
		// The identity of the file this run created: only it is removed on failure, never whatever holds the path later.
		const made = fstatSync(fd, { bigint: true });
		try {
			const fileProblems = (options.verifyFile ?? verifyFileAccess)(file);
			if (fileProblems.length > 0) throw new Error(`the secret file ${file} is not restricted as required; nothing was written to it:\n${fileProblems.map((p) => `  - ${p}`).join("\n")}`);
			writeSync(fd, randomBytes(PASSWORD_BYTES).toString("base64url"));
		} catch (error) {
			closeSync(fd);
			try {
				removeIfSame(file, made);
			} catch (removal) {
				// The original failure stays the one reported; the file that could not be removed is named in it.
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n(the empty file ${file} could not be removed: ${removal instanceof Error ? removal.message : String(removal)})`);
			}
			throw error;
		}
		closeSync(fd);
		created.push(name);
	}
	// What counts is the access that results, read back, not that a command was run.
	const problems = verifySecretsAccess(target);
	if (problems.length > 0) throw new Error(`the secrets directory ${target} is not restricted as required:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	return { directory: target, created, kept };
};

if (import.meta.main) {
	const usage = "usage: node deploy/setup-secrets.ts [--check | --check-access] <directory>";
	try {
		const { present, positionals } = parseCliArgs(process.argv.slice(2), { flags: { "--check": "boolean", "--check-access": "boolean" }, positionals: 1 });
		if (present.has("--check") && present.has("--check-access")) throw new UsageError("--check and --check-access cannot be used together");
		const directory = positionals[0] as string;
		if (present.has("--check-access")) {
			const problems = directoryAccessProblems(directory);
			if (problems.length === 0) console.log(`access ok: ${resolve(directory)} is open to the current user, SYSTEM and Administrators only`);
			else {
				console.error(`access NOT ok: ${resolve(directory)}`);
				for (const problem of problems) console.error(`  - ${problem}`);
				process.exitCode = 1;
			}
		} else if (present.has("--check")) {
			const problems = secretsReadiness(directory);
			if (problems.length === 0) console.log(`secrets ready: ${resolve(directory)} holds all ${SECRET_NAMES.length} valid secret files, open to the current user, SYSTEM and Administrators only, and cannot be committed`);
			else {
				console.error(`secrets NOT ready: ${resolve(directory)}`);
				for (const problem of problems) console.error(`  - ${problem}`);
				process.exitCode = 1;
			}
		} else {
			// Before anything is created: a new directory inside a checkout that does not ignore it is refused.
			const placed = worktreeProblems([directory]);
			if (placed.length > 0) throw new Error(`refused: nothing was created.\n${placed.map((p) => `  - ${p}`).join("\n")}`);
			const result = createSecrets(directory);
			console.log(`secrets directory: ${result.directory}`);
			console.log(`created: ${result.created.join(", ") || "none"}`);
			console.log(`kept (not overwritten): ${result.kept.join(", ") || "none"}`);
		}
	} catch (error) {
		reportCliFailure(error, "setup-secrets", usage);
	}
}
