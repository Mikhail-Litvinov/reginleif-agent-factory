// The access rules shared by every directory that holds secret material: the secrets directory (setup-secrets.ts) and the
// backup target and its staging directories (backup/backup.ts), because a dump holds the whole database.
//
// On Windows the access is read BACK by SID (well-known SIDs, so a localized system does not matter) and must hold only
// the current user, SYSTEM and Administrators, inherited entries included. Elsewhere the check is the mode: nothing for
// group or others. Nothing here writes a secret byte; callers verify first and write after.
import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";

export const SID_SYSTEM = "S-1-5-18";
export const SID_ADMINISTRATORS = "S-1-5-32-544";

// The user of this process cannot change while it runs, so the SID is asked once (a failed ask is not remembered).
let cachedUserSid: string | undefined;
export const currentUserSid = (): string => {
	if (cachedUserSid) return cachedUserSid;
	const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
	const sid = /"(S-1-\d+(?:-\d+)+)"/.exec(result.stdout ?? "")?.[1];
	if (result.status !== 0 || !sid) throw new Error(`could not read the current user's SID: ${result.stderr || result.stdout}`);
	cachedUserSid = sid;
	return sid;
};

// The SIDs that have an access entry on each of the paths, read back from the system in ONE PowerShell start (a start
// costs about as much as the whole read; the order of the answer is the order of `paths`). Any path that cannot be read
// fails the whole call: $ErrorActionPreference = Stop makes the first failure end the script with a non-zero exit, so a
// path that was not read never reads as "no entries".
export const aclSidsOf = (paths: readonly string[]): string[][] => {
	if (paths.length === 0) return [];
	// Get-Acl asked for SecurityIdentifier objects: the SID is never translated to a (localized) name. Each answer line is
	// `<index of the path>|<sid>`.
	const script =
		"$ErrorActionPreference = 'Stop'; $paths = ConvertFrom-Json $env:AF_ACL_PATHS; " +
		"for ($i = 0; $i -lt $paths.Count; $i++) { " +
		"$prefix = $i.ToString() + '|'; " +
		"(Get-Acl -LiteralPath $paths[$i]).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $prefix + $_.IdentityReference.Value } }";
	// The paths go through the environment as JSON: with -Command, extra arguments are joined into the command text, so a
	// path with a space reached Get-Acl cut at the first space and the read-back came back empty.
	const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		env: { ...process.env, AF_ACL_PATHS: JSON.stringify(paths) },
	});
	if (result.status !== 0) throw new Error(`could not read the ACL of ${paths.join(", ")}: ${result.stderr || result.stdout}`);
	const sids = paths.map(() => [] as string[]);
	for (const line of result.stdout.split(/\r?\n/)) {
		const match = /^(\d+)\|(S-1-\d+(?:-\d+)*)$/.exec(line.trim());
		if (match) sids[Number(match[1])]?.push(match[2] as string);
	}
	return sids;
};

// The SIDs that have an access entry on a path, read back from the system.
export const aclSids = (path: string): string[] => aclSidsOf([path])[0] as string[];

// The access of exactly these paths, read back (the effective ACL, inherited entries included, on Windows). An empty list
// means the paths are open to the allowed holders only. Read-only: it changes nothing.
export const pathsAccessProblems = (paths: string[]): string[] => {
	const problems: string[] = [];
	if (process.platform === "win32") {
		const user = currentUserSid();
		const allowed = new Set([user, SID_SYSTEM, SID_ADMINISTRATORS]);
		const read = aclSidsOf(paths);
		for (const [index, path] of paths.entries()) {
			const sids = read[index] as string[];
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

// Sets the access of a directory explicitly and not by what it happens to carry: inheritance off, the three allowed
// holders granted, and every other entry the directory already had (a grant or a deny; inherited ones were turned into
// explicit entries by the inheritance step) removed by SID. Elsewhere: mode 700. `label` names the directory in an error.
export const restrictDirectory = (directory: string, label: string): void => {
	if (process.platform !== "win32") {
		chmodSync(directory, 0o700);
		return;
	}
	const allowed = [currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS];
	const icacls = (args: string[]): void => {
		const result = spawnSync("icacls", [directory, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`icacls failed on the ${label}: ${result.stderr || result.stdout}`);
	};
	// "/inheritance:r" copies nothing (the inherited entries are dropped); "/grant:r" replaces those holders' own entries.
	icacls(["/inheritance:r", "/grant:r", ...allowed.map((sid) => `*${sid}:(OI)(CI)F`)]);
	for (const sid of new Set(aclSids(directory))) {
		if (!allowed.includes(sid)) icacls(["/remove", `*${sid}`]);
	}
};
