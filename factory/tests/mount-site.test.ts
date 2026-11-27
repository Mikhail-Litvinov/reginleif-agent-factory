// A compose line counts as a mount site only when a file it names declares a volume. The lines below are text handed to the
// parser, never run, so this file is listed as text-only in owned-creation-guard.test.ts (like removal-guard.test.ts); the
// tests that run docker stay in volume-identity.test.ts, where the creation guard reads every line.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMountSite } from "./doc-parse.ts";

describe("mount sites: a compose line counts only when a file it names declares a volume", () => {
	it("the main compose file with its pgdata volume is a mount site", () => {
		assert.ok(isMountSite("docker compose -p agent-factory -f factory/deploy/compose.yml up -d"));
	});
	it("the embedder compose file declares no volume, so its line is not a mount site", () => {
		assert.equal(isMountSite("docker compose -p af-embedder -f factory/deploy/embedder/compose.yml up -d --build"), false);
	});
	it("an -f that cannot be resolved, or no -f, stays a mount site", () => {
		assert.ok(isMountSite('docker compose -p agent-factory -f "$old/compose.yml" up -d'));
		assert.ok(isMountSite("docker compose -p agent-factory -f factory/deploy/no-such-file.yml up -d"));
		assert.ok(isMountSite("docker compose -p agent-factory up -d"));
	});
});
