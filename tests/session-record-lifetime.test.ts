import { describe, expect, test } from "bun:test";

import { listSessions, lookupSession } from "../src/session-core.js";
import { withSessionEnding } from "../src/session-ending.js";
import { apiOk } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const ID = "lifetime";
const NAMED = "/home/test/.claude/projects/old/lifetime.jsonl";
const OTHER = "/home/test/.claude/projects/other/lifetime.jsonl";
const CREATED = "creation";
const MARKER = `${ROOT}/${ID}/ending.json`;
const GUARD = `${ROOT}/${ID}.ending.lock`;
// An independent rig caller contending with the memory runtime's default owner.
const OTHER_OWNER_PID = 51;

const gate = () => {
	let open = () => {};
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
};

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: NAMED, started_at: "start" }));
	h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify({ pid: 42, pid_created: CREATED, started_at: "start" }));
	h.runtime.process.createdAt = async () => ok({ "42": null });
	return h;
};

describe("session record lifetime", () => {
	test("removal waits for marker creation under the shared guard and keeps the live marker", async () => {
		const h = setup();
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === h.runtime.lock.process.pid ? CREATED : null])));
		const creating = gate();
		const create = gate();
		const entered = gate();
		const release = gate();
		const waiting = gate();
		const retry = gate();
		const write = h.fs.writeExclusive.bind(h.fs);
		h.fs.writeExclusive = async (path, text) => {
			if (path === MARKER) { creating.open(); await create.promise; }
			return write(path, text);
		};
		const owner = withSessionEnding(h.runtime, ID, async () => { entered.open(); await release.promise; return apiOk(null); });
		const reader = { ...h.runtime, lock: { ...h.runtime.lock, process: { ...h.runtime.lock.process, pid: OTHER_OWNER_PID }, clock: { ...h.runtime.lock.clock, sleep: async () => { waiting.open(); await retry.promise; } } } };
		let removing: Promise<Awaited<ReturnType<typeof lookupSession>>> | undefined;
		try {
			await creating.promise;
			expect(await h.fs.stat(GUARD)).not.toBeNull();
			removing = lookupSession(reader, ID);
			expect(await Promise.race([waiting.promise.then(() => "waiting"), removing.then(() => "finished")])).toBe("waiting");
			create.open();
			await entered.promise;
			retry.open();
			expect((await removing).ok).toBe(true);
			expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
			expect(h.fs.files.has(MARKER)).toBe(true);
		} finally { create.open(); retry.open(); release.open(); await Promise.allSettled([owner, removing]); }
		expect(await h.fs.stat(GUARD)).toBeNull();
	});

	test("marker creation waits for removal and recreates its folder only after removal released the guard", async () => {
		const h = setup();
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === OTHER_OWNER_PID ? CREATED : null])));
		const deleting = gate();
		const remove = gate();
		const entered = gate();
		const release = gate();
		const waiting = gate();
		const retry = gate();
		const deleteFile = h.fs.remove.bind(h.fs);
		h.fs.remove = async (path) => {
			if (path === `${ROOT}/${ID}.json`) { deleting.open(); await remove.promise; }
			await deleteFile(path);
		};
		const removing = lookupSession(h.runtime, ID);
		const caller = { ...h.runtime, lock: { ...h.runtime.lock, process: { ...h.runtime.lock.process, pid: OTHER_OWNER_PID }, clock: { ...h.runtime.lock.clock, sleep: async () => { waiting.open(); await retry.promise; } } } };
		let owner: Promise<Awaited<ReturnType<typeof withSessionEnding>>> | undefined;
		try {
			await deleting.promise;
			expect(await h.fs.stat(GUARD)).not.toBeNull();
			owner = withSessionEnding(caller, ID, async () => { entered.open(); await release.promise; return apiOk(null); });
			expect(await Promise.race([waiting.promise.then(() => "waiting"), owner.then(() => "finished")])).toBe("waiting");
			expect(h.fs.files.has(MARKER)).toBe(false);
			remove.open();
			const result = await removing;
			expect(result.ok ? "ok" : result.error.code).toBe("session-unknown");
			expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
			retry.open();
			await entered.promise;
			expect(h.fs.files.has(MARKER)).toBe(true);
			expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(true);
			expect(await h.fs.stat(GUARD)).toBeNull();
		} finally { remove.open(); retry.open(); release.open(); await Promise.allSettled([removing, owner]); }
		expect(await h.fs.stat(MARKER)).toBeNull();
		expect(await h.fs.stat(GUARD)).toBeNull();
	});

	test("a live ending owner keeps the record and marker for lookup and list", async () => {
		const h = setup();
		const marker = `${ROOT}/${ID}/ending.json`;
		h.fs.seed(marker, JSON.stringify({ pid: 51, pidCreated: CREATED, token: "first", takenOver: true, otherOwners: [{ pid: 52, pidCreated: CREATED, token: "second" }] }));
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === 52 ? CREATED : null])));
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		const list = await listSessions(h.runtime);
		expect(list.ok && list.value.sessions.length).toBe(1);
		expect(h.fs.files.has(marker)).toBe(true);
	});
	test("a stale ending owner does not keep the record", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/${ID}/ending.json`, JSON.stringify({ pid: 51, pidCreated: CREATED, token: "first", takenOver: false, otherOwners: [] }));
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === 51 ? "reused" : null])));
		const lookup = await lookupSession(h.runtime, ID);
		expect(lookup.ok ? "ok" : lookup.error.code).toBe("session-unknown");
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
	});
	test("an incomplete ending owner query preserves the record", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/${ID}/ending.json`, JSON.stringify({ pid: 51, pidCreated: CREATED, token: "first", takenOver: false, otherOwners: [] }));
		expect((await lookupSession(h.runtime, ID)).ok).toBe(false);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
	});
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
