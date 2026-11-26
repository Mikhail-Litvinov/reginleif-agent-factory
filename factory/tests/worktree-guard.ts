// No test may write into the worktree. Global setup records the untracked, non-ignored paths under factory/; global
// teardown records them again and fails the run listing every path that appeared in between. Only paths that appeared
// during the run count, so files another agent already had or edits concurrently (tracked files, files present at the
// start) never fire it; ignored paths (factory/.tmp, node_modules) are not listed by git at all.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FACTORY_DIR = fileURLToPath(new URL("..", import.meta.url));

// `-z` output: entries separated by NUL, untracked ones start with "?? " (no quoting of odd names in -z mode).
export const parseUntracked = (porcelainZ: string): string[] =>
	porcelainZ
		.split("\0")
		.filter((entry) => entry.startsWith("?? "))
		.map((entry) => entry.slice(3));

export const newPaths = (before: ReadonlySet<string> | readonly string[], after: readonly string[]): string[] => {
	const seen = new Set(before);
	return after.filter((path) => !seen.has(path)).sort();
};

export const snapshotUntracked = async (): Promise<string[]> => {
	const { stdout } = await promisify(execFile)("git", ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."], {
		cwd: FACTORY_DIR,
		maxBuffer: 64 * 1024 * 1024,
	});
	return parseUntracked(stdout);
};

export const worktreeGuardMessage = (created: readonly string[]): string =>
	`the test run wrote into the worktree (use a disposable directory under os.tmpdir()): ${created.join(", ")}`;
