// Guards against stacks left behind by a test run (a container, volume and network labelled af.run, and an
// af-test-secrets-* directory): every way a process can end must leave nothing, or leave only what the next run removes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OwnedDir } from "../deploy/owned.ts";
import { leftovers, Cleanups } from "./helpers.ts";
import { removeOwned, stackEnv } from "../deploy/lib.ts";
import { sweepStale } from "./dead-owners.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

describe("Cleanups", () => {
	it("waits for a creator that is still running, so what it creates afterwards is removed too", async () => {
		const cleanups = new Cleanups();
		const order: string[] = [];
		let finish: () => void = () => {};
		const gate = new Promise<void>((resolve) => (finish = resolve));
		const creator = cleanups.track(
			(async () => {
				await gate;
				cleanups.add(async () => void order.push("removed"));
				order.push("created");
			})(),
		);
		const disposing = cleanups.runAll(); // like an after hook that ran while the before hook was still creating
		finish();
		await creator;
		await disposing;
		assert.deepEqual(order, ["created", "removed"]);
	});

	it("runs every action, last registered first, and reports all failures together", async () => {
		const cleanups = new Cleanups();
		const order: string[] = [];
		cleanups.add(async () => void order.push("first"));
		cleanups.add(async () => {
			throw new Error("second fails");
		});
		cleanups.add(async () => void order.push("third"));
		await assert.rejects(cleanups.runAll(), (error: unknown) => error instanceof AggregateError && /second fails/.test(String(error.errors[0])));
		assert.deepEqual(order, ["third", "first"]);
	});

	it("disposeAllLive removes what an after hook that never ran would have left", async () => {
		const cleanups = new Cleanups();
		let removed = false;
		cleanups.add(async () => void (removed = true));
		await Cleanups.disposeAllLive();
		assert.equal(removed, true);
		await Cleanups.disposeAllLive(); // nothing left: a second call does nothing
	});
});

describe("the root hook", () => {
	it("disposes a test file's cleanups that its own after hook left undone", async () => {
		const dir = await makeScratch("af-test-roothook-");
		try {
			const marker = join(dir.path, "marker");
			const fixture = fileURLToPath(new URL("./leak-root-fixture.ts", import.meta.url));
			// NODE_TEST_CONTEXT is removed (an empty value is not enough) so that the nested runner starts as a top-level one.
			const { NODE_TEST_CONTEXT: _outer, ...env } = process.env;
			await promisify(execFile)(process.execPath, ["--test", fixture], { env: { ...env, AF_FIXTURE_MARKER: marker } });
			assert.equal(await exists(marker), true, "the root after hook ran the registered cleanup");
		} finally {
			await disposeScratch(dir);
		}
	});
});

describe("stack labels", () => {
	it("the secrets directory's identity goes onto the stack only for the test harness and only for a directory it made", async () => {
		const dir = await makeScratch("af-test-labels-");
		const saved = process.env.AF_OWNER;
		try {
			const options = { project: "p", port: 1, runId: "0123456789ab" };
			assert.ok(saved, "helpers.ts sets the owner of this process");
			assert.equal(stackEnv({ ...options, secretsDir: dir.path }).AF_SECRETS_LABEL, `${dir.token}@${dir.path}`);
			assert.equal(stackEnv({ ...options, secretsDir: `${dir.path}-other` }).AF_SECRETS_LABEL, undefined);
			delete process.env.AF_OWNER;
			assert.equal(stackEnv({ ...options, secretsDir: dir.path }).AF_SECRETS_LABEL, undefined);
		} finally {
			process.env.AF_OWNER = saved;
			await disposeScratch(dir);
		}
	});
});

describe("a process that ends without running its cleanup", () => {
	it("leaves a stack that the next run of this worktree removes, with its secrets directory", async () => {
		const cleanups = new Cleanups();
		// NODE_TEST_CONTEXT is cleared so that the child is not taken for a test file (it would register the root hook).
		const { stdout } = await promisify(execFile)(process.execPath, ["tests/dead-owner-child.ts"], { env: { ...process.env, NODE_TEST_CONTEXT: "" } });
		const made = JSON.parse(stdout) as { runId: string; secretsDir: string; token: string };
		// Safety net for a failing sweep: only this child's own resources, by its run id and by the recorded identity.
		cleanups.add(() => removeOwned(made.runId));
		cleanups.add(async () => {
			const dir = await OwnedDir.reclaim(made.secretsDir, made.token);
			await dir?.adoptChildren();
			await dir?.remove();
		});
		try {
			assert.ok((await leftovers(made.runId)).length >= 3, "the dead process left a container, a volume and a network");
			assert.equal(await exists(made.secretsDir), true);
			const result = await sweepStale();
			assert.ok(result.swept.includes(made.runId));
			assert.deepEqual(await leftovers(made.runId), []);
			assert.equal(await exists(made.secretsDir), false);
		} finally {
			await cleanups.runAll();
		}
	});
});
