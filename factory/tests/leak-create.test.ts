// createTestStack must register its creation with its cleanups: an after hook that runs while a stack is still being
// created (a before hook that timed out does not stop its body) has to wait for the creation and then remove the result.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeOwned, runChecked } from "../deploy/lib.ts";
import { OwnedDir } from "../deploy/owned.ts";
import { currentOwner } from "./dead-owners.ts";
import { Cleanups, createTestStack, type TestStack } from "./helpers.ts";

// Everything of this process's stacks that still exists (this file's process owns no other stack).
const ownedHere = async (): Promise<string[]> => {
	const filter = `label=af.owner=${currentOwner()}`;
	const found: string[] = [];
	for (const [kind, args] of [
		["container", ["ps", "-a"]],
		["network", ["network", "ls"]],
		["volume", ["volume", "ls"]],
	] as const) {
		const text = await runChecked("docker", [...args, "--filter", filter, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"]);
		for (const line of text.split(/\r?\n/)) if (line.trim() !== "") found.push(`${kind} ${line.trim()}`);
	}
	return found;
};

describe("createTestStack", () => {
	it("leaves nothing when the cleanups are disposed while the stack is still being created", async () => {
		const creating = createTestStack(); // not awaited: the creation is running when the disposal starts
		let stack: TestStack | undefined;
		try {
			await Cleanups.disposeAllLive();
			stack = await creating;
			assert.deepEqual(await ownedHere(), []);
		} finally {
			// Safety net for a failing test: the stack that appeared after the disposal, with its secrets directory.
			stack ??= await creating.catch(() => undefined);
			if (stack !== undefined) {
				await removeOwned(stack.runId);
				const token = OwnedDir.tokenOf(stack.secretsDir);
				const dir = token === undefined ? undefined : await OwnedDir.reclaim(stack.secretsDir, token);
				await dir?.adoptChildren();
				await dir?.remove();
			}
		}
	});
});
