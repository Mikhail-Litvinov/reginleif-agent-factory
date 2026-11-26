import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newPaths, parseUntracked, worktreeGuardMessage } from "./worktree-guard.ts";

describe("worktree guard", () => {
	it("reads only untracked entries from git status -z output", () => {
		const out = ["?? b/x.dump", " M tests/a.ts", "A  new.ts", "?? with space/y"].join("\0") + "\0";
		assert.deepEqual(parseUntracked(out), ["b/x.dump", "with space/y"]);
		assert.deepEqual(parseUntracked(""), []);
	});

	it("reports only paths that appeared during the run", () => {
		const before = ["notes.md", "wip/a.ts"];
		assert.deepEqual(newPaths(before, ["notes.md", "wip/a.ts"]), []);
		assert.deepEqual(newPaths(before, ["wip/a.ts", "b/z.dump", "b/a.dump"]), ["b/a.dump", "b/z.dump"]);
		assert.deepEqual(newPaths(before, []), [], "a file removed during the run is not a new path");
	});

	it("names every new path in the failure", () => {
		assert.match(worktreeGuardMessage(["b/a.dump", "b/z.dump"]), /b\/a\.dump, b\/z\.dump/);
	});
});
