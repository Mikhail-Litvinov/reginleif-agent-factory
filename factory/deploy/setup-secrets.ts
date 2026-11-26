// Creates the secrets directory of the Agent Factory database: one file with a random password per account.
//
//   node deploy/setup-secrets.ts <directory>          create what is missing, then verify the access
//   node deploy/setup-secrets.ts --check <directory>  verify only (changes nothing)
//
// A file that exists is never overwritten (a changed password would lock the running database out). Passwords are
// never printed. A new secret file is created EMPTY and exclusively, its own effective access (what it inherited from
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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { idOfStats, sameId } from "./identity.ts";

// One secret per account; the first is the bootstrap superuser of the server (init and recovery only).
export const SECRET_NAMES = ["af_bootstrap", "af_migrator", "af_api", "af_control", "af_backup", "af_reader"] as const;

// 32 random bytes = 256 bits, base64url so that the text holds only A-Z a-z 0-9 _ - (the init script checks it).
const PASSWORD_BYTES = 32;

export const SID_SYSTEM = "S-1-5-18";
export const SID_ADMINISTRATORS = "S-1-5-32-544";

export interface SecretsResult {
	readonly directory: string;
	readonly created: string[];
	readonly kept: string[];
}

const currentUserSid = (): string => {
	const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
	const sid = /"(S-1-\d+(?:-\d+)+)"/.exec(result.stdout ?? "")?.[1];
	if (result.status !== 0 || !sid) throw new Error(`could not read the current user's SID: ${result.stderr || result.stdout}`);
	return sid;
};

// The SIDs that have an access entry on a path, read back from the system (icacls /sid prints SIDs, not names).
export const aclSids = (path: string): string[] => {
	// Get-Acl asked for SecurityIdentifier objects: the SID is never translated to a (localized) name.
	const script =
		"$a = Get-Acl -LiteralPath $env:AF_ACL_PATH; " +
		"$a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
	// The path goes through the environment: with -Command, extra arguments are joined into the command text, so a path
	// with a space reached Get-Acl cut at the first space and the read-back came back empty.
	const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		env: { ...process.env, AF_ACL_PATH: path },
	});
	if (result.status !== 0) throw new Error(`could not read the ACL of ${path}: ${result.stderr || result.stdout}`);
	return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^S-1-\d+(?:-\d+)*$/.test(l));
};

const secretFiles = (directory: string): string[] => SECRET_NAMES.map((n) => join(directory, n)).filter((f) => existsSync(f));

// The access of the directory and of each secret file that exists; an empty list means exactly the allowed holders.
// Read-only: it changes nothing.
export const verifySecretsAccess = (directory: string): string[] => {
	const target = resolve(directory);
	if (!existsSync(target)) return [`${target} does not exist`];
	return pathsAccessProblems([target, ...secretFiles(target)]);
};

// The access of exactly these paths, read back (the effective ACL, inherited entries included, on Windows).
const pathsAccessProblems = (paths: string[]): string[] => {
	const problems: string[] = [];
	if (process.platform === "win32") {
		const user = currentUserSid();
		const allowed = new Set([user, SID_SYSTEM, SID_ADMINISTRATORS]);
		for (const path of paths) {
			const sids = aclSids(path);
			for (const sid of new Set(sids)) {
				if (!allowed.has(sid)) problems.push(`${path}: access entry for ${sid}, which is not the current user, SYSTEM or Administrators`);
			}
			if (!sids.includes(user)) problems.push(`${path}: the current user has no access entry`);
		}
	} else {
		for (const path of paths) {
			const mode = statSync(path).mode & 0o777;
			if ((mode & 0o077) !== 0) problems.push(`${path}: mode ${mode.toString(8)} gives access to group or others`);
		}
	}
	return problems;
};

// The access of one secret file that was just created, before any secret byte is in it: the file's own effective
// ACL (what it inherited from the directory included) and the directory it sits in.
export const verifyFileAccess = (file: string): string[] => pathsAccessProblems([dirname(file), file]);

// Sets the access of a directory that holds no secret yet, explicitly and not by what it happens to carry: inheritance
// off, the three allowed holders granted, and every other entry the directory already had (a grant or a deny, inherited
// ones were turned into explicit entries by the inheritance step) removed by SID. Elsewhere: mode 700.
const restrict = (directory: string): void => {
	if (process.platform !== "win32") {
		chmodSync(directory, 0o700);
		return;
	}
	const allowed = [currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS];
	const icacls = (args: string[]): void => {
		const result = spawnSync("icacls", [directory, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`icacls failed on the secrets directory: ${result.stderr || result.stdout}`);
	};
	// "/inheritance:r" copies nothing (the inherited entries are dropped); "/grant:r" replaces those holders' own entries.
	icacls(["/inheritance:r", "/grant:r", ...allowed.map((sid) => `*${sid}:(OI)(CI)F`)]);
	for (const sid of new Set(aclSids(directory))) {
		if (!allowed.includes(sid)) icacls(["/remove", `*${sid}`]);
	}
};

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
	const argv = process.argv.slice(2);
	const checkOnly = argv[0] === "--check";
	const directory = checkOnly ? argv[1] : argv[0];
	if (!directory || argv.length > (checkOnly ? 2 : 1)) {
		console.error("usage: node deploy/setup-secrets.ts [--check] <secrets directory>");
		process.exitCode = 2;
	} else if (checkOnly) {
		const problems = verifySecretsAccess(directory);
		if (problems.length === 0) console.log(`secrets access ok: ${resolve(directory)} is open to the current user, SYSTEM and Administrators only`);
		else {
			console.error(`secrets access NOT ok: ${resolve(directory)}`);
			for (const problem of problems) console.error(`  - ${problem}`);
			process.exitCode = 1;
		}
	} else {
		try {
			const result = createSecrets(directory);
			console.log(`secrets directory: ${result.directory}`);
			console.log(`created: ${result.created.join(", ") || "none"}`);
			console.log(`kept (not overwritten): ${result.kept.join(", ") || "none"}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
