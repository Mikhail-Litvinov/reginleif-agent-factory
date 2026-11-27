import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeBench } from "./database-bench.ts";

// A bench that owns its stack must not run DROP DATABASE: the stack is already removed by the helpers.ts `after` hook.
test("an owned stack is removed and no DROP DATABASE runs against the already removed container", async () => {
	let dropped = 0;
	let removed = 0;
	await disposeBench(
		true,
		async () => {
			dropped++;
			throw new Error("No such container");
		},
		async () => {
			removed++;
		},
	);
	assert.equal(dropped, 0);
	assert.equal(removed, 1);
});

test("a shared stack is left alone and only the database is dropped", async () => {
	let dropped = 0;
	let removed = 0;
	await disposeBench(false, async () => void dropped++, async () => void removed++);
	assert.deepEqual([dropped, removed], [1, 0]);
});

test("a failed drop on the shared stack is reported", async () => {
	await assert.rejects(
		disposeBench(false, async () => {
			throw new Error("boom");
		}, async () => {}),
		AggregateError,
	);
});
