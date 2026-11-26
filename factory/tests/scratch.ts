// Private scratch directories for tests. A test makes one under the language temp directory (mkdtemp: exclusive, a name
// nobody else has) and the helper records its identity; disposeScratch adopts what the test and the code under test wrote
// inside and removes it entry by entry, each by its recorded identity and without recursion (deploy/owned.ts). Nothing in
// the tests deletes a tree by path.
import { tmpdir } from "node:os";
import { OwnedDir } from "../deploy/owned.ts";

export const makeScratch = (prefix: string): Promise<OwnedDir> => OwnedDir.make(tmpdir(), prefix);

// Removes the directory. Throws when something stays (an entry that changed identity, or a foreign one), so a leftover is
// loud in the test that left it. A directory that is already gone is fine.
export const disposeScratch = async (dir: OwnedDir | undefined): Promise<void> => {
	if (dir === undefined) return;
	await dir.adoptChildren().catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	const problems = await dir.remove();
	if (problems.length > 0) throw new Error(`scratch directory ${dir.path} not fully removed: ${problems.join("; ")}`);
};
