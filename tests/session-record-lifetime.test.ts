import { describe, expect, test } from "bun:test";

import { listSessions, lookupSession } from "../src/session-core.js";
import { LAUNCH_REGISTRATION_WAIT_MS } from "../src/commands/session-run.js";
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
// Arbitrary session-process identity used by the hook fixtures.
const SESSION_PID = 42;
// An independent rig caller contending with the memory runtime's default owner.
const OTHER_OWNER_PID = 51;

const gate = () => {
	let open = () => {};
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
};

const setup = () => {
	const h = createMemoryRuntime();
	// This feature exercises directory renames; the shared fake models file renames only.
	const rename = h.fs.rename.bind(h.fs);
	h.fs.rename = async (from, to) => {
		if (!h.fs.directories.has(from)) return rename(from, to);
		if (h.fs.directories.has(to)) throw Object.assign(new Error("Directory exists"), { code: "EEXIST" });
		for (const [path, text] of [...h.fs.files]) {
			if (!path.startsWith(`${from}/`)) continue;
			h.fs.seed(`${to}${path.slice(from.length)}`, text);
			h.fs.files.delete(path);
		}
		for (const path of [...h.fs.directories]) {
			if (path !== from && !path.startsWith(`${from}/`)) continue;
			h.fs.directories.add(`${to}${path.slice(from.length)}`);
			h.fs.directories.delete(path);
		}
	};
	h.fs.seed(`${ROOT}/${ID}.json`, JSON.stringify({ session_id: ID, cwd: "/work", transcript_path: NAMED, started_at: "start" }));
	h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify({ pid: 42, pid_created: CREATED, started_at: "start" }));
	h.runtime.process.createdAt = async () => ok({ "42": null });
	return h;
};

describe("session record lifetime", () => {
	for (const boundary of ["record-detached", "folder-retired", "record-discarded"] as const) test(`listing sweeps leftovers after ${boundary}`, async () => {
		const h = setup();
		const detached = `${ROOT}/${ID}.json.retired-killed`;
		await h.fs.rename(`${ROOT}/${ID}.json`, detached);
		if (boundary !== "record-detached") await h.fs.rename(`${ROOT}/${ID}`, `${ROOT}/${ID}.retired-killed`);
		if (boundary === "record-discarded") await h.fs.remove(detached);
		const result = await listSessions(h.runtime);
		expect(result.ok && result.value.sessions).toEqual([]);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	test("listing reports the record and live registration recovered during retention", async () => {
		const h = setup();
		let registered = false;
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			await rename(from, to);
			if (from === `${ROOT}/${ID}.json`) {
				registered = true;
				h.fs.seed(from, JSON.stringify({ session_id: ID, cwd: "/registered", transcript_path: NAMED, started_at: "registered" }));
			}
		};
		h.runtime.process.createdAt = async () => ok({ "42": registered ? CREATED : null });
		const result = await listSessions(h.runtime);
		expect(result.ok && result.value.sessions[0]).toMatchObject({ cwd: "/registered", live: true, pid: SESSION_PID });
	});

	test("listing recovers a detached record and its retired live registration", async () => {
		const h = setup();
		await h.fs.rename(`${ROOT}/${ID}.json`, `${ROOT}/${ID}.json.retired-killed`);
		await h.fs.rename(`${ROOT}/${ID}`, `${ROOT}/${ID}.retired-killed`);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		const result = await listSessions(h.runtime);
		expect(result.ok && result.value.sessions[0]).toMatchObject({ id: ID, live: true, pid: SESSION_PID });
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});
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

	test("marker creation waits for record removal to release the guard", async () => {
		const h = setup();
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), pid === OTHER_OWNER_PID ? CREATED : null])));
		const deleting = gate();
		const remove = gate();
		const entered = gate();
		const release = gate();
		const waiting = gate();
		const retry = gate();
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			if (from === `${ROOT}/${ID}.json`) { deleting.open(); await remove.promise; }
			await rename(from, to);
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
	for (const pending of [true, false]) test(`a dead owner's launch ${pending ? "keeps the record until" : "allows removal at"} its registration deadline`, async () => {
		const h = setup();
		h.runtime.clock.now = () => new Date(pending ? 0 : LAUNCH_REGISTRATION_WAIT_MS);
		h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: CREATED, token: "launching", takenOver: false, launch: { startedAt: 0, registrationWaitMs: LAUNCH_REGISTRATION_WAIT_MS }, otherOwners: [] }));
		h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), null])));
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok ? "ok" : result.error.code).toBe(pending ? "ok" : "session-unknown");
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(pending);
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

	for (const reader of ["lookup", "list"] as const) {
		for (const boundary of ["before-detach", "after-detach", "after-recheck"] as const) {
			test(`${reader} preserves registration ${boundary} during record removal`, async () => {
				const h = setup();
				const path = `${ROOT}/${ID}.json`;
				let registered = false;
				const register = () => {
					registered = true;
					// SessionStart publishes this process first, then replaces the record.
					h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify({ pid: 42, pid_created: CREATED, started_at: "registered" }));
					h.fs.seed(path, JSON.stringify({ session_id: ID, cwd: "/registered", transcript_path: NAMED, started_at: "registered" }));
				};
				h.runtime.process.createdAt = async () => ok({ "42": registered ? CREATED : null });
				const rename = h.fs.rename.bind(h.fs);
				h.fs.rename = async (from, to) => {
					if (from === path && boundary === "before-detach") register();
					await rename(from, to);
					if (from === path && boundary === "after-detach") register();
				};
				const remove = h.fs.remove.bind(h.fs);
				h.fs.remove = async (candidate) => {
					// Also exercises the old implementation's deletion boundary, so it loses the registration.
					if (!registered && (candidate === path || boundary === "after-recheck" && candidate.startsWith(`${path}.retired-`))) register();
					await remove(candidate);
				};
				if (reader === "lookup") expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
				else {
					const result = await listSessions(h.runtime);
					expect(result.ok && result.value.sessions.length).toBe(1);
				}
				expect(registered).toBe(true);
				expect(JSON.parse(await h.fs.readText(path)).cwd).toBe("/registered");
				expect(h.fs.files.has(`${ROOT}/${ID}/processes/42.json`)).toBe(true);
				expect([...h.fs.files.keys()].some((candidate) => candidate.includes(".retired-"))).toBe(false);
			});
		}
	}

	test("registration published before its record restores the detached record", async () => {
		const h = setup();
		const path = `${ROOT}/${ID}.json`;
		let registered = false;
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			await rename(from, to);
			if (from === path) {
				registered = true;
				h.fs.seed(`${ROOT}/${ID}/processes/42.json`, JSON.stringify({ pid: 42, pid_created: CREATED, started_at: "registered" }));
			}
		};
		h.runtime.process.createdAt = async () => ok({ "42": registered ? CREATED : null });
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok && result.value.processes[0]?.startedAt).toBe("registered");
		expect(h.fs.files.has(path)).toBe(true);
	});

	test("a failed registration recheck restores the detached record", async () => {
		const h = setup();
		let detached = false;
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => { await rename(from, to); if (from === `${ROOT}/${ID}.json`) detached = true; };
		h.runtime.process.createdAt = async () => detached ? err("query failed") : ok({ "42": null });
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok ? "ok" : result.error.code).toBe("session-io");
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}/processes/42.json`)).toBe(true);
	});

	for (const recreate of [false, true]) test(`registration just before folder retirement survives with ${recreate ? "a recreated" : "no replacement"} folder`, async () => {
		const h = setup();
		const folder = `${ROOT}/${ID}`;
		const process = `${folder}/processes/${SESSION_PID}.json`;
		let registered = false;
		const queries: number[][] = [];
		h.runtime.process.createdAt = async (pids) => {
			queries.push([...pids]);
			return ok({ [String(SESSION_PID)]: registered ? CREATED : null });
		};
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			if (from === folder) {
				registered = true;
				h.fs.seed(process, JSON.stringify({ pid: SESSION_PID, pid_created: CREATED, started_at: "just-registered" }));
			}
			await rename(from, to);
			if (from === folder && recreate) h.fs.seed(`${folder}/processes/${OTHER_OWNER_PID}.json`, JSON.stringify({ pid: OTHER_OWNER_PID, pid_created: CREATED, started_at: "replacement" }));
		};
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok && result.value.processes.some((candidate) => candidate.startedAt === "just-registered")).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		expect(h.fs.files.has(process)).toBe(true);
		if (recreate) expect(h.fs.files.has(`${folder}/processes/${OTHER_OWNER_PID}.json`)).toBe(true);
		// Initial retention, detached-record recheck, then exactly one moved-folder identity query.
		expect(queries).toEqual([[SESSION_PID], [SESSION_PID], [SESSION_PID]]);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	for (const code of ["EBUSY", "EPERM", "EACCES"]) test(`a ${code} folder retirement keeps the record and folder for a later lookup`, async () => {
		const h = setup();
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			if (from === `${ROOT}/${ID}`) throw Object.assign(new Error("Folder is open"), { code });
			await rename(from, to);
		};
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}/processes/42.json`)).toBe(true);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
		h.fs.rename = rename;
		const retry = await lookupSession(h.runtime, ID);
		expect(retry.ok ? "ok" : retry.error.code).toBe("session-unknown");
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
	});

	for (const boundary of ["record-detached", "folder-retired", "record-discarded"] as const) test(`lookup sweeps a killed remover after ${boundary}`, async () => {
		const h = setup();
		const record = `${ROOT}/${ID}.json`;
		const detached = `${record}.retired-killed`;
		const retiredFolder = `${ROOT}/${ID}.retired-killed`;
		await h.fs.rename(record, detached);
		if (boundary !== "record-detached") await h.fs.rename(`${ROOT}/${ID}`, retiredFolder);
		if (boundary === "record-discarded") await h.fs.remove(detached);
		h.fs.seed(`${ROOT}/${ID}-other.retired-killed/processes/42.json`, "unrelated");
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok ? "ok" : result.error.code).toBe("session-unknown");
		expect(h.fs.files.has(detached)).toBe(false);
		expect(h.fs.directories.has(retiredFolder)).toBe(false);
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(false);
		expect(h.fs.files.has(`${ROOT}/${ID}-other.retired-killed/processes/42.json`)).toBe(true);
	});

	for (const retainedBy of ["process", "transcript"] as const) test(`retention sweeps leftovers even when a ${retainedBy} keeps the record`, async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/${ID}.json.retired-killed`, await h.fs.readText(`${ROOT}/${ID}.json`));
		h.fs.seed(`${ROOT}/${ID}.retired-killed/usage.json`, "{}");
		if (retainedBy === "process") h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		else h.fs.seed(NAMED, "{}");
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	test("a killed remover's retired registration and detached record are recovered", async () => {
		const h = setup();
		await h.fs.rename(`${ROOT}/${ID}.json`, `${ROOT}/${ID}.json.retired-killed`);
		await h.fs.rename(`${ROOT}/${ID}`, `${ROOT}/${ID}.retired-killed`);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}/processes/42.json`)).toBe(true);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	test("recovery merges live process files without overwriting newer hook publications", async () => {
		const h = setup();
		const path = `${ROOT}/${ID}.json`;
		const process = `${ROOT}/${ID}/processes/${SESSION_PID}.json`;
		await h.fs.rename(path, `${path}.retired-killed`);
		await h.fs.rename(`${ROOT}/${ID}`, `${ROOT}/${ID}.retired-killed`);
		const record = JSON.stringify({ session_id: ID, cwd: "/new", transcript_path: NAMED, started_at: "new" });
		const registration = JSON.stringify({ pid: SESSION_PID, pid_created: CREATED, started_at: "new" });
		h.fs.seed(path, record);
		h.fs.seed(process, registration);
		h.runtime.process.createdAt = async () => ok({ [String(SESSION_PID)]: CREATED });
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(await h.fs.readText(path)).toBe(record);
		expect(await h.fs.readText(process)).toBe(registration);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	test("an unavailable ending guard postpones collection without failing lookup", async () => {
		const h = setup();
		const write = h.fs.writeExclusive.bind(h.fs);
		h.fs.writeExclusive = async (path, text) => path === GUARD ? err("Guard unavailable") : write(path, text);
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		expect(h.fs.directories.has(`${ROOT}/${ID}`)).toBe(true);
	});

	test("a failed retired-folder delete is deferred and swept by the next lookup", async () => {
		const h = setup();
		const remove = h.fs.removeDirectoryTree.bind(h.fs);
		h.fs.removeDirectoryTree = async () => { throw Object.assign(new Error("Directory busy"), { code: "EBUSY" }); };
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(h.fs.files.has(`${ROOT}/${ID}.json`)).toBe(true);
		h.fs.removeDirectoryTree = remove;
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok ? "ok" : result.error.code).toBe("session-unknown");
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});

	test("a partially completed recovery keeps lookup usable and retries folder restoration", async () => {
		const h = setup();
		const folder = `${ROOT}/${ID}`;
		const retired = `${folder}.retired-killed`;
		await h.fs.rename(`${folder}.json`, `${folder}.json.retired-killed`);
		await h.fs.rename(folder, retired);
		h.runtime.process.createdAt = async () => ok({ [String(SESSION_PID)]: CREATED });
		const rename = h.fs.rename.bind(h.fs);
		h.fs.rename = async (from, to) => {
			if (from === retired && to === folder) throw Object.assign(new Error("Folder is open"), { code: "EPERM" });
			await rename(from, to);
		};
		expect((await lookupSession(h.runtime, ID)).ok).toBe(true);
		expect(h.fs.files.has(`${retired}/processes/${SESSION_PID}.json`)).toBe(true);
		h.fs.rename = rename;
		const result = await lookupSession(h.runtime, ID);
		expect(result.ok && result.value.processes.some((process) => process.pid === SESSION_PID)).toBe(true);
		expect((await h.fs.listDirectory(ROOT)).some((entry) => entry.name.includes(".retired-"))).toBe(false);
	});
});
