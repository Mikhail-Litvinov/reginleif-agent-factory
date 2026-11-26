// Stacks that a test process left behind because it was killed (a runner or a test file process that ended without
// running its cleanup: SIGKILL, TaskStop, a crash, process.exit). No cleanup code runs in such a process, so the NEXT run
// of the same worktree removes what the dead one left.
//
// How a stack is tied to its maker. Every stack the test harness creates carries, next to af.run, two labels (compose.run.yml):
//   af.owner   = "<worktree key>:<pid of the process that made it>"
//   af.secrets = "<identity of its secrets directory>@<the directory's path>"
// The worktree key is a hash of the absolute path of this package, so it names this checkout and no other.
//
// Why the sweep cannot remove anything that is not ours or not abandoned:
//  - It looks only at objects that carry an af.owner label whose key is this worktree's key. Objects without our labels
//    (the real project, anything another tool made) never match, and neither do objects of another worktree: their key
//    differs, so a run going on there at the same time is never touched.
//  - It removes a stack only when the pid in its owner label is no longer a live process and is not this process. A live
//    owner means a run still using it. A pid that was reused by an unrelated live process reads as "alive", so the stack
//    stays (a leak, never a wrong removal).
//  - Removal goes through removeOwned(runId): exactly the objects that carry that run's label, nothing selected by a
//    name pattern or a project name. The secrets directory is removed by the identity recorded at creation
//    (OwnedDir.reclaim), so a path that now names another directory is left alone.
//  - A run whose objects disagree about their owner is skipped (fail closed).
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { removeOwned, runChecked } from "../deploy/lib.ts";
import { OwnedDir } from "../deploy/owned.ts";

export const OWNER_LABEL = "af.owner";
export const SECRETS_LABEL = "af.secrets";

const PACKAGE_ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export const worktreeKey = (root: string): string => createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0, 12);

export const ownerLabel = (key: string, pid: number): string => `${key}:${pid}`;

/** The owner label of stacks made by this process. */
export const currentOwner = (): string => ownerLabel(worktreeKey(PACKAGE_ROOT), process.pid);

/** One labelled docker object (a container, volume or network) of a stack made by the harness. */
export interface Listed {
	readonly runId: string;
	readonly owner: string;
	readonly secrets: string;
}

export interface SweepDeps {
	readonly key: string;
	readonly ownPid: number;
	alive(pid: number): boolean;
	list(): Promise<Listed[]>;
	removeRun(runId: string): Promise<void>;
	/** Returns a problem text, or undefined when the directory is removed or is not the recorded one any more. */
	removeSecrets(path: string, token: string): Promise<string | undefined>;
}

export interface SweepResult {
	readonly swept: string[];
	readonly kept: string[];
}

const parseOwner = (owner: string): { key: string; pid: number } | undefined => {
	const match = /^([0-9a-f]{12}):(\d+)$/.exec(owner);
	return match === null ? undefined : { key: match[1] as string, pid: Number(match[2]) };
};

export const sweepDeadOwners = async (deps: SweepDeps): Promise<SweepResult> => {
	const byRun = new Map<string, Listed[]>();
	for (const item of await deps.list()) byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
	const result: { swept: string[]; kept: string[] } = { swept: [], kept: [] };
	const errors: string[] = [];
	for (const [runId, items] of byRun) {
		const owners = new Set(items.map((item) => item.owner));
		const parsed = owners.size === 1 ? parseOwner([...owners][0] as string) : undefined;
		if (parsed === undefined || parsed.key !== deps.key) continue; // not ours (or malformed or ambiguous): never touched
		if (parsed.pid === deps.ownPid || deps.alive(parsed.pid)) {
			result.kept.push(runId);
			continue;
		}
		try {
			await deps.removeRun(runId);
			result.swept.push(runId);
		} catch (error) {
			errors.push(`run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const secrets of new Set(items.map((item) => item.secrets).filter((text) => text !== ""))) {
			const at = secrets.indexOf("@");
			if (at < 0) continue;
			const problem = await deps.removeSecrets(secrets.slice(at + 1), secrets.slice(0, at));
			if (problem !== undefined) errors.push(`run ${runId}: ${problem}`);
		}
	}
	if (errors.length > 0) throw new Error(`sweep of dead owners failed: ${errors.join("; ")}`);
	return result;
};

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0); // signal 0 only checks that the process exists
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

const FORMAT = `{{.Label "af.run"}}\t{{.Label "${OWNER_LABEL}"}}\t{{.Label "${SECRETS_LABEL}"}}`;

const listKind = async (args: string[]): Promise<Listed[]> => {
	const text = await runChecked("docker", [...args, "--filter", `label=${OWNER_LABEL}`, "--format", FORMAT]);
	const items: Listed[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const [runId = "", owner = "", secrets = ""] = line.split("\t");
		if (/^[0-9a-f]{12}$/.test(runId)) items.push({ runId, owner, secrets });
	}
	return items;
};

export const realSweepDeps = (): SweepDeps => ({
	key: worktreeKey(PACKAGE_ROOT),
	ownPid: process.pid,
	alive: processAlive,
	list: async () => [
		...(await listKind(["ps", "-a"])),
		...(await listKind(["network", "ls"])),
		...(await listKind(["volume", "ls"])),
	],
	removeRun: (runId) => removeOwned(runId),
	removeSecrets: async (path, token) => {
		const dir = await OwnedDir.reclaim(path, token);
		if (dir === undefined) return undefined;
		await dir.adoptChildren().catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		const problems = await dir.remove();
		return problems.length > 0 ? `secrets directory ${path} not fully removed: ${problems.join("; ")}` : undefined;
	},
});

/** Removes the stacks that earlier runs of this worktree left, see the header. */
export const sweepStale = (): Promise<SweepResult> => sweepDeadOwners(realSweepDeps());
