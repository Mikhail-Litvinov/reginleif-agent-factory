import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkTestServerSha256, pinnedTestServerSha256 } from "./bench.ts";

const sha256Of = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

describe("workflow test server pin", () => {
	let dir: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "af-test-server-pin-"));
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("accepts a file whose sha256 is the pinned value", async () => {
		const path = join(dir, "accepted.exe");
		await writeFile(path, "server bytes");
		checkTestServerSha256(path, sha256Of("server bytes"));
	});

	it("refuses a file whose sha256 differs, naming the file and both hashes", async () => {
		const path = join(dir, "replaced.exe");
		await writeFile(path, "another build");
		const expected = sha256Of("the release build");
		assert.throws(
			() => checkTestServerSha256(path, expected),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(path) &&
				error.message.includes(sha256Of("another build")) &&
				error.message.includes(expected),
		);
	});

	it("refuses a platform that has no pinned hash", () => {
		assert.throws(() => pinnedTestServerSha256("linux", "x64"), /no pinned sha256 for the workflow test server on linux-x64/);
	});
});
