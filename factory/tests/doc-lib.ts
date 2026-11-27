// Shared by the tests that run the commands of the operator docs (docs/agent-factory/*.md) as written: running them in Windows
// PowerShell 5.1, the shell they are written for, and restricting a directory of copies. The pure parsers live in
// doc-parse.ts (no child_process there) and are re-exported below, so the importers of this module keep working.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./doc-parse.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

export * from "./doc-parse.ts";

export interface PsResult {
	readonly code: number | null;
	// The output of each command, split at the markers written before it. A command that never started has no entry.
	readonly steps: string[];
	readonly stdout: string;
	readonly stderr: string;
}

export interface PsOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	// Lines run first, not part of the result (variable setup).
	readonly prelude?: readonly string[];
	readonly timeoutMs?: number;
}

// Runs the commands one after the other as one script of Windows PowerShell 5.1 (a file: the console has no stdin here), each
// preceded by a marker. A command that ends with a non-zero exit code of a program ends the script with that code, as a
// person would stop; a throw ends it with 1.
export const runPs = async (commands: readonly string[], options: PsOptions = {}): Promise<PsResult> => {
	const lines: string[] = [...(options.prelude ?? [])];
	commands.forEach((command, index) => {
		lines.push(`Write-Output '@@STEP ${index}'`, "$global:LASTEXITCODE = 0", command, "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
	});
	const script = `${lines.join("\r\n")}\r\n`;
	if (/[^\x00-\x7f]/.test(script)) throw new Error("a script for PowerShell 5.1 must be ASCII");
	const scratch = await makeScratch("af-ps-");
	try {
		const file = join(scratch.path, "run.ps1");
		writeFileSync(file, script, "ascii");
		const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
			cwd: options.cwd ?? REPO_ROOT,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 600_000);
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
		clearTimeout(timer);
		const steps: string[] = [];
		for (const part of stdout.split(/^@@STEP \d+\r?\n/m).slice(1)) steps.push(part);
		return { code, steps, stdout, stderr };
	} finally {
		await disposeScratch(scratch);
	}
};

// The access the docs prescribe for a directory of copies (deployment.md "Backup"): the current user, SYSTEM and
// Administrators only, set by SID so a localized system does not matter. `extra` adds entries (a test grants everyone).
export const restrictDir = async (path: string, extra: readonly string[] = []): Promise<void> => {
	const whoami = await new Promise<string>((resolve, reject) => {
		const child = spawn("whoami", ["/user", "/fo", "csv", "/nh"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
		child.on("error", reject);
		child.on("close", () => resolve(out));
	});
	const sid = /"(S-[\d-]+)"\s*$/.exec(whoami.trim())?.[1];
	if (sid === undefined) throw new Error(`cannot read the current user's SID from: ${whoami}`);
	const grants = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", `*${sid}:(OI)(CI)F`, ...extra];
	const code = await new Promise<number | null>((resolve, reject) => {
		const child = spawn("icacls", [path, "/inheritance:r", "/grant:r", ...grants], { stdio: "ignore" });
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (code !== 0) throw new Error(`icacls failed with ${code} on ${path}`);
};

// PowerShell text of a single-quoted string.
export const psq = (value: string): string => `'${value.replaceAll("'", "''")}'`;
