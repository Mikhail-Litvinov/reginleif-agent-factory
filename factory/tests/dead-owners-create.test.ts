// A test process that is killed right after it created docker objects (before it recorded or registered anything) must
// leave nothing that the next sweep of this worktree cannot find and remove: the objects carry af.run and af.owner from the
// moment they exist, and the anonymous volume of the container (which cannot carry a label) is found through the container.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { recordVolumes, removeOwned, removeRecordedVolumes, run } from "../deploy/lib.ts";
import { sweepStale } from "./dead-owners.ts";
import { Cleanups, leftovers } from "./helpers.ts";

const exists = async (kind: "container" | "volume" | "network", name: string): Promise<boolean> => (await run("docker", [kind, "inspect", name])).code === 0;

describe("a process killed right after creating docker objects", () => {
	const cleanups = new Cleanups();
	after(async () => {
		await cleanups.runAll();
	});

	it("leaves objects that the next sweep removes, the container's anonymous volume included", async () => {
		const child = fileURLToPath(new URL("./owned-create-child.ts", import.meta.url));
		// NODE_TEST_CONTEXT is cleared so that the child is not taken for a test file (it would register the root hook).
		const result = await run(process.execPath, [child], { env: { NODE_TEST_CONTEXT: "" } });
		const made = JSON.parse(result.stdout) as { runId: string; volume: string; network: string; container: string };
		const anonymous: string[] = [];
		// Safety net for a failing sweep: only what this child made, by its run id and by the volume name read below.
		cleanups.add(() => removeRecordedVolumes(anonymous));
		cleanups.add(() => removeOwned(made.runId));

		anonymous.push(...(await recordVolumes(made.container)));
		assert.equal(anonymous.length, 1, "the container has one anonymous volume");
		assert.equal((await leftovers(made.runId)).length, 3, "the dead process left a container, a labelled volume and a network, all labelled");
		assert.equal(await exists("volume", anonymous[0] as string), true);

		const swept = await sweepStale();

		assert.ok(swept.swept.includes(made.runId));
		assert.deepEqual(await leftovers(made.runId), []);
		assert.equal(await exists("container", made.container), false);
		assert.equal(await exists("volume", made.volume), false);
		assert.equal(await exists("network", made.network), false);
		assert.equal(await exists("volume", anonymous[0] as string), false, "the anonymous volume of the swept container is removed too");
	});
});
