// Creates the secrets directory of the Agent Factory database: one file with a random password per account.
//
//   node deploy/setup-secrets.ts <directory>          create what is missing, then verify the access
//   node deploy/setup-secrets.ts --check <directory>  verify only (changes nothing)
//
// A file that exists is never overwritten (a changed password would lock the running database out). Passwords are
// never printed.
//
// Access: on Windows the directory is restricted by ACL to the current user, SYSTEM and Administrators (well-known SIDs,
// so a localized system does not matter), and the ACL is READ BACK by SID for the directory and for every secret file;
// the result must hold only those three, with no other entry. Elsewhere the check is the mode: nothing for group or
// others. A directory that already holds secrets is never restricted silently: when its access is wider than that, the
// command refuses and says which entry is the problem, and the owner decides. A directory that exists but is still empty
// (for example one just made by mkdtemp) has nothing to protect yet, so it is restricted and then verified.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
		"$a = Get-Acl -LiteralPath $args[0]; " +
		"$a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
	const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `& { ${script} }`, path], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`could not read the ACL of ${path}: ${result.stderr || result.stdout}`);
	return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^S-1-\d+(?:-\d+)*$/.test(l));
};

const secretFiles = (directory: string): string[] => SECRET_NAMES.map((n) => join(directory, n)).filter((f) => existsSync(f));

// The access of the directory and of each secret file that exists; an empty list means exactly the allowed holders.
// Read-only: it changes nothing.
export const verifySecretsAccess = (directory: string): string[] => {
	const target = resolve(directory);
	const problems: string[] = [];
	if (!existsSync(target)) return [`${target} does not exist`];
	const paths = [target, ...secretFiles(target)];
	if (process.platform === "win32") {
		const allowed = new Set([currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS]);
		for (const path of paths) {
			const sids = aclSids(path);
			for (const sid of new Set(sids)) {
				if (!allowed.has(sid)) problems.push(`${path}: access entry for ${sid}, which is not the current user, SYSTEM or Administrators`);
			}
			if (!sids.includes(currentUserSid())) problems.push(`${path}: the current user has no access entry`);
		}
	} else {
		for (const path of paths) {
			const mode = statSync(path).mode & 0o777;
			if ((mode & 0o077) !== 0) problems.push(`${path}: mode ${mode.toString(8)} gives access to group or others`);
		}
	}
	return problems;
};

const restrict = (directory: string): void => {
	if (process.platform !== "win32") return;
	const grants = [currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS].map((sid) => `*${sid}:(OI)(CI)F`);
	const result = spawnSync("icacls", [directory, "/inheritance:r", "/grant:r", ...grants], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`icacls failed on the secrets directory: ${result.stderr || result.stdout}`);
};

const refuse = (target: string, problems: string[]): Error =>
	new Error(
		`refused: the secrets directory ${target} already holds secrets and its access is wider than allowed; it was not changed.\n` +
			problems.map((p) => `  - ${p}`).join("\n") +
			"\nRemove those entries yourself (for example icacls <path> /remove:g *<sid>) and run the command again.",
	);

export const createSecrets = (directory: string): SecretsResult => {
	const target = resolve(directory);
	const reused = existsSync(target) && secretFiles(target).length > 0;
	if (reused) {
		const problems = verifySecretsAccess(target);
		if (problems.length > 0) throw refuse(target, problems);
	} else {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		restrict(target);
	}
	const created: string[] = [];
	const kept: string[] = [];
	for (const name of SECRET_NAMES) {
		const file = join(target, name);
		if (existsSync(file)) {
			kept.push(name);
			continue;
		}
		// "wx" fails when the file appeared meanwhile, so a race cannot overwrite either.
		writeFileSync(file, randomBytes(PASSWORD_BYTES).toString("base64url"), { flag: "wx", mode: 0o600 });
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
