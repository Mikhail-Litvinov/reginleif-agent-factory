import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { OwnedDir } from "../deploy/owned.ts";

/**
 * A private temp directory for one test, removed when the test ends by the identity-checked OwnedDir (never by a delete of
 * the test's own). Everything the test wrote inside it is recorded just before removal, because the test writes it itself
 * into a directory it made privately. A leftover that is not this test's is reported as a failure.
 */
export const ownedTempDir = async (t: TestContext, prefix: string): Promise<string> => {
	const owned = await OwnedDir.make(tmpdir(), prefix);
	t.after(async () => {
		await owned.adoptChildren();
		assert.deepEqual(await owned.remove(), []);
	});
	return owned.path;
};
