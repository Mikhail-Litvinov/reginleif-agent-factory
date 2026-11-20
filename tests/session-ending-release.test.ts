import { expect, test } from "bun:test";

import { apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { withSessionEnding } from "../src/session-ending.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

test("release reports takeover when the marker vanished", async () => {
	const h = createMemoryRuntime();
	h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), "created"])));
	let takenOver = false;
	const result = await withSessionEnding(h.runtime, "abc", async () => {
		await h.fs.remove("/home/test/.agent-rig/sessions/abc/ending.json");
		return apiOk(null);
	}, undefined, (value, interrupted) => { takenOver = interrupted; return value; });
	expect(result).toEqual(apiOk(null));
	expect(takenOver).toBe(true);
});
