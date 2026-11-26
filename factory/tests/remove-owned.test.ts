// removeOwned acts on the identity of what a run created: objects selected by the run's own label, never by something
// they merely belong to. A container's anonymous volume carries no label of its own (docker marks it only as anonymous),
// so the run did not select it, and removing the container must leave it where it is. The test recorded its name at
// creation and removes exactly that volume at the end.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { newRunId, ownedResources, recordVolumes, removeOwned, removeRecordedVolumes, run } from "../deploy/lib.ts";
import { Cleanups } from "./helpers.ts";
import { createContainer, createVolume } from "./owned-docker.ts";

const IMAGE = "alpine:latest";

const exists = async (kind: "container" | "volume", name: string): Promise<boolean> =>
	(await run("docker", [kind, "inspect", name])).code === 0;

describe("removeOwned removes what the run selected by its label, not what hangs off it", () => {
	const cleanups = new Cleanups();
	after(async () => {
		await cleanups.runAll();
	});

	it("an anonymous volume of a labelled container is not removed with the container", async () => {
		const runId = newRunId();
		const recorded: string[] = [];
		// Registered before the resources exist: the container goes first (by label), then the volume this test recorded.
		cleanups.add(() => removeRecordedVolumes(recorded));
		cleanups.add(() => removeOwned(runId));
		const container = await createContainer(runId, "-v", "/data", IMAGE, "true");
		recorded.push(...(await recordVolumes(container)));
		assert.equal(recorded.length, 1, "the container must have exactly one anonymous volume");

		await removeOwned(runId);

		assert.equal(await exists("container", container), false, "the labelled container is removed");
		assert.equal(await exists("volume", recorded[0] as string), true, "the unlabelled anonymous volume was not selected, so it stays");
	});

	it("a labelled volume is removed, and another run's labelled container and volume are untouched", async () => {
		const mine = newRunId();
		const other = newRunId();
		cleanups.add(() => removeOwned(other));
		cleanups.add(() => removeOwned(mine));
		const volume = await createVolume(mine, `af-test-${mine}`);
		const otherVolume = await createVolume(other, `af-test-${other}`);
		const otherContainer = await createContainer(other, "-v", `${otherVolume}:/data`, IMAGE, "true");

		await removeOwned(mine);

		assert.equal(await exists("volume", volume), false);
		assert.equal(await exists("container", otherContainer), true);
		assert.equal(await exists("volume", otherVolume), true);
		assert.deepEqual((await ownedResources(other)).containers.length, 1);
	});

	it("removeRecordedVolumes refuses a volume that is not anonymous", async () => {
		const runId = newRunId();
		cleanups.add(() => removeOwned(runId));
		// A named volume (an unnamed one is made anonymous by docker).
		const volume = await createVolume(runId, `af-test-${runId}`);
		await assert.rejects(removeRecordedVolumes([volume]), /not anonymous/);
		assert.equal(await exists("volume", volume), true);
	});
});
