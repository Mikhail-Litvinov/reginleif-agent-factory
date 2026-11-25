// Creates the secrets directory of the Agent Factory database: one file with a random password per account.
//
//   node deploy/setup-secrets.ts <directory>
//
// A file that exists is never overwritten (a changed password would lock the running database out). Passwords are
// never printed. On Windows the directory is restricted to the current user by ACL; elsewhere by mode 0700/0600.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";

// One secret per account; the first is the bootstrap superuser of the server (init and recovery only).
export const SECRET_NAMES = ["af_bootstrap", "af_migrator", "af_api", "af_control", "af_backup", "af_reader"] as const;

// 32 random bytes = 256 bits, base64url so that the text holds only A-Z a-z 0-9 _ - (the init script checks it).
const PASSWORD_BYTES = 32;

export interface SecretsResult {
	readonly directory: string;
	readonly created: string[];
	readonly kept: string[];
}

// Restricts the directory to the current user: inheritance removed, one full-control grant for the user.
const restrictToCurrentUser = (directory: string): void => {
	if (process.platform !== "win32") return;
	const account = `${process.env["USERDOMAIN"] ?? ""}\\${userInfo().username}`.replace(/^\\/, "");
	const result = spawnSync("icacls", [directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`icacls failed on the secrets directory: ${result.stderr || result.stdout}`);
};

export const createSecrets = (directory: string): SecretsResult => {
	const target = resolve(directory);
	mkdirSync(target, { recursive: true, mode: 0o700 });
	restrictToCurrentUser(target);
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
	return { directory: target, created, kept };
};

if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory) {
		console.error("usage: node deploy/setup-secrets.ts <secrets directory>");
		process.exitCode = 2;
	} else {
		const result = createSecrets(directory);
		console.log(`secrets directory: ${result.directory}`);
		console.log(`created: ${result.created.join(", ") || "none"}`);
		console.log(`kept (not overwritten): ${result.kept.join(", ") || "none"}`);
	}
}
