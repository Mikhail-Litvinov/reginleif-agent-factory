import { describe, expect, test } from "bun:test";

import { listSessions, lookupSession } from "../src/session-core.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const ID = "lifetime";
const NAMED = "/home/test/.claude/projects/old/lifetime.jsonl";
const OTHER = "/home/test/.claude/projects/other/lifetime.jsonl";
const CREATED = "creation";

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: NAMED, started_at: "start" }));
	h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify({ pid: 42, pid_created: CREATED, started_at: "start" }));
	h.runtime.process.createdAt = async () => ok({ "42": null });
	return h;
};

describe("session record lifetime", () => {
	test("list removes an expired record and lookup reports it missing", async () => {
		const h = setup();
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions).toEqual([]);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(false);
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
		expect(h.fs.files.has(`${ROOT}/${ID}/processes/42.json`)).toBe(false);
		const lookup = await lookupSession(h.runtime, ID);
		expect(lookup.ok ? "ok" : lookup.error.code).toBe("session-unknown");
	});
	test("lookup also removes an expired record", async () => {
		const h = setup();
		const lookup = await lookupSession(h.runtime, ID);
		expect(lookup.ok ? "ok" : lookup.error.code).toBe("session-unknown");
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(false);
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
	});
	test("a live process keeps a record before its transcript exists", async () => {
		const h = setup();
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions.length).toBe(1);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
	});
	test("a transcript in another project keeps a stopped session", async () => {
		const h = setup();
		h.fs.seed(OTHER, "{}");
		const lookup = await lookupSession(h.runtime, ID);
		expect(lookup.ok && lookup.value.transcriptPath).toBe(OTHER);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions.length).toBe(1);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
	});
	test("a failed process query keeps the record", async () => {
		const h = setup();
		h.runtime.process.createdAt = async () => err("query failed");
		expect((await lookupSession(h.runtime, ID)).ok).toBe(false);
		await listSessions(h.runtime);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(true);
	});
});
