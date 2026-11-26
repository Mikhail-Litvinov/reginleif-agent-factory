import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OwnedDir } from "../deploy/owned.ts";
import { ownerLabel, sweepDeadOwners, worktreeKey, type Listed, type SweepDeps } from "./dead-owners.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const MINE = worktreeKey("E:/a/this-worktree");
const OTHER = worktreeKey("E:/b/another-worktree");

interface Recorded {
	removedRuns: string[];
	secrets: Array<[string, string]>;
}

const deps = (listed: Listed[], alive: number[], recorded: Recorded, overrides: Partial<SweepDeps> = {}): SweepDeps => ({
	key: MINE,
	ownPid: 100,
	alive: (pid) => alive.includes(pid),
	list: async () => listed,
	removeRun: async (runId) => void recorded.removedRuns.push(runId),
	removeSecrets: async (path, token) => void recorded.secrets.push([path, token]),
	...overrides,
});

const item = (runId: string, owner: string, secrets = ""): Listed => ({ runId, owner, secrets });
const fresh = (): Recorded => ({ removedRuns: [], secrets: [] });

describe("sweepDeadOwners", () => {
	it("removes the stack of a dead owner of this worktree, with its secrets directory", async () => {
		const recorded = fresh();
		const listed = [item("aaaaaaaaaaaa", ownerLabel(MINE, 7), "1:2:3@E:/tmp/af-test-secrets-x"), item("aaaaaaaaaaaa", ownerLabel(MINE, 7), "1:2:3@E:/tmp/af-test-secrets-x")];
		const result = await sweepDeadOwners(deps(listed, [], recorded));
		assert.deepEqual(result.swept, ["aaaaaaaaaaaa"]);
		assert.deepEqual(recorded.removedRuns, ["aaaaaaaaaaaa"]);
		assert.deepEqual(recorded.secrets, [["E:/tmp/af-test-secrets-x", "1:2:3"]]);
	});

	it("keeps a stack whose owner is still alive, and the stack of this very process", async () => {
		const recorded = fresh();
		const listed = [item("aaaaaaaaaaaa", ownerLabel(MINE, 7)), item("bbbbbbbbbbbb", ownerLabel(MINE, 100))];
		const result = await sweepDeadOwners(deps(listed, [7], recorded));
		assert.deepEqual(result.kept.sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		assert.deepEqual(recorded.removedRuns, []);
	});

	it("never touches another worktree's stack, an unlabelled one, a malformed owner or objects that disagree", async () => {
		const recorded = fresh();
		const listed = [
			item("aaaaaaaaaaaa", ownerLabel(OTHER, 7), "1:2:3@E:/other"),
			item("bbbbbbbbbbbb", ""),
			item("cccccccccccc", "not-an-owner"),
			item("dddddddddddd", ownerLabel(MINE, 7)),
			item("dddddddddddd", ownerLabel(MINE, 8)),
		];
		const result = await sweepDeadOwners(deps(listed, [], recorded));
		assert.deepEqual(result, { swept: [], kept: [] });
		assert.deepEqual(recorded, { removedRuns: [], secrets: [] });
	});

	it("reports a failed removal after trying every stack, and leaves that stack's secrets for the next try", async () => {
		const recorded = fresh();
		const listed = [item("aaaaaaaaaaaa", ownerLabel(MINE, 7), "1:2:3@E:/a"), item("bbbbbbbbbbbb", ownerLabel(MINE, 8), "4:5:6@E:/b")];
		const failing = deps(listed, [], recorded, {
			removeRun: async (runId) => {
				recorded.removedRuns.push(runId);
				if (runId === "aaaaaaaaaaaa") throw new Error("docker said no");
			},
		});
		await assert.rejects(sweepDeadOwners(failing), /aaaaaaaaaaaa: docker said no/);
		assert.deepEqual(recorded.removedRuns, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		assert.deepEqual(recorded.secrets, [["E:/b", "4:5:6"]]);
	});
});

describe("secrets directory identity", () => {
	it("is reclaimed by a later process only under the identity recorded at creation", async () => {
		const dir = await makeScratch("af-test-owned-");
		let imposter: OwnedDir | undefined;
		try {
			await writeFile(join(dir.path, "file"), "x");
			assert.equal(OwnedDir.tokenOf(dir.path), dir.token);
			const same = await OwnedDir.reclaim(dir.path, dir.token);
			assert.ok(same);
			assert.equal(await OwnedDir.reclaim(dir.path, "1:2:3"), undefined, "another identity");
			assert.equal(await OwnedDir.reclaim(dir.path, "garbage"), undefined, "malformed token");
			imposter = await makeScratch("af-test-owned-");
			assert.equal(await OwnedDir.reclaim(imposter.path, dir.token), undefined, "another directory under the recorded token");
			assert.equal(OwnedDir.tokenOf(join(dir.path, "nope")), undefined);
		} finally {
			await disposeScratch(imposter);
			await disposeScratch(dir);
		}
		await assert.rejects(access(dir.path));
	});
});
