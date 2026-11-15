import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { cleanupSession } from "../src/commands/session-cleanup.js";
import { endSession, stopSession } from "../src/commands/session-stop.js";
import { cleanTranscript } from "../src/commands/session-transcript.js";
import { runCli } from "../src/cli.js";
import { messagesFor } from "../src/messages.js";
import { apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "creation";
const SESSION: SessionRecord = { id: "abc", cwd: null, transcriptPath: null, pid: 42, pidCreated: CREATED, startedAt: "start", endedAt: null };
const RAW = { session_id: "abc", cwd: null, transcript_path: null, pid: 42, pid_created: CREATED, started_at: "start", ended_at: null };
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/abc.json`, JSON.stringify(RAW));
	h.fs.directories.add(`${ROOT}/abc`);
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	h.runtime.process.createdAt = async () => ok({ "42": CREATED });
	return h;
};
const response = (h: ReturnType<typeof setup>, id: string, result: unknown) => h.fs.seed(`${ROOT}/abc/responses/${id}.json`, JSON.stringify({ id, ok: true, result }));

describe("session stop and cleanup", () => {
	test("reports invalid transcript records in the selected language", async () => {
		for (const language of ["en", "ru"] as const) {
			const h = setup();
			h.runtime.language = language;
			h.fs.seed("/transcripts/abc.jsonl", '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{}]}}');
			const result = await cleanTranscript(h.runtime, "/transcripts/abc.jsonl");
			expect(result.ok ? "ok" : result.error).toBe(messagesFor(language).session.skillsRecord());
		}
	});
	test("CLI emits one JSON object for each subcommand", async () => {
		for (const command of ["stop", "cleanup"]) {
			const h = setup();
			const lines: string[] = [];
			const code = await runCli(["session", command, "missing"], (line) => lines.push(line), h.runtime);
			expect(code).toBe(1);
			expect(lines.length).toBe(1);
			expect(JSON.parse(lines[0]).error.code).toBe("session-unknown");
		}
	});
	test("compacts only above the threshold before stopping", async () => {
		for (const tokens of [120_000, 120_001]) {
			const h = setup();
			response(h, "event-1", { context: { tokens } });
			response(h, "event-2", { tokensBefore: tokens, tokensAfter: 1 });
			let killed = false;
			h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
			h.runtime.process.createdAt = async () => ok({ "42": killed ? null : CREATED });
			const result = await stopSession(h.runtime, SESSION, () => {});
			expect(result.ok && result.value.stopped && result.value.compacted).toEqual(tokens > 120_000 ? { tokensBefore: tokens, tokensAfter: 1 } : null);
			expect(killed).toBe(true);
		}
	});
	test("does not kill a reused PID and reports exit timeout", async () => {
		const h = setup();
		let kills = 0;
		h.runtime.process.killTree = async () => { kills++; return ok(undefined); };
		h.runtime.process.createdAt = async () => ok({ "42": "reused" });
		expect(await endSession(h.runtime, SESSION)).toEqual(apiOk(false));
		expect(kills).toBe(0);
		h.runtime.process.createdAt = async () => ok({ "42": CREATED });
		const result = await endSession(h.runtime, SESSION);
		expect(result.ok ? "ok" : result.error.code).toBe("session-stop-timeout");
	});
	test("does not stop or edit when compaction does not shrink", async () => {
		for (const compact of [{ tokensBefore: 10, tokensAfter: 10 }, { tokensBefore: 10, tokensAfter: 11 }, { skip: "vetoed" }]) {
			const h = setup();
			response(h, "event-1", compact);
			let kills = 0;
			h.runtime.process.killTree = async () => { kills++; return ok(undefined); };
			const result = await cleanupSession(h.runtime, SESSION, () => {});
			expect(result.ok ? "ok" : result.error.code).toBe("session-cleanup-not-compacted");
			expect(kills).toBe(0);
		}
	});
	test("preserves other bytes, retains three backups, and retries locks", async () => {
		const h = setup();
		const directory = "/transcripts";
		const path = `${directory}/abc.jsonl`;
		const original = Buffer.concat([Buffer.from([255, 10]), Buffer.from('{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"a","content":"b"}]}}\r\n')]);
		for (let index = 1; index <= 4; index++) {
			h.runtime.clock.now = () => new Date(index);
			h.fs.files.delete(path); h.fs.binaries.delete(path);
			await h.fs.appendBytes(path, original);
			let attempts = 0;
			const result = await cleanTranscript(h.runtime, path, async (from, to) => { if (++attempts === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" }); await h.fs.rename(from, to); });
			expect(result.ok).toBe(true);
			expect(attempts).toBe(2);
			expect(Buffer.from(await h.fs.readRange(path, 0, original.length))).toEqual(Buffer.concat([Buffer.from([255, 10]), Buffer.from('{"type":"attachment","attachment":{"type":"invoked_skills","skills":[]}}\r\n')]));
		}
		expect((await h.fs.listDirectory(directory)).filter((entry) => entry.name.includes(".cleanup-")).length).toBe(3);
	});
	test("leaves transcript intact when replacement stays locked", async () => {
		const h = setup();
		const directory = "/transcripts";
		const path = `${directory}/abc.jsonl`;
		const original = '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"a","content":"b"}]}}';
		h.fs.seed(path, original);
		const result = await cleanTranscript(h.runtime, path, async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); });
		expect(result.ok).toBe(false);
		expect(await h.fs.readText(path)).toBe(original);
		expect((await h.fs.listDirectory(directory)).map((entry) => entry.name)).toEqual(["abc.jsonl"]);
	});
});
