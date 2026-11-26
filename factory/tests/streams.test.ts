// Backup plumbing that needs no server: stream failures, the wait for a healthy server with a fake clock, and the
// strict, content-level validation of a backup's files. Fast: no docker, no real waiting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { MANIFEST_FORMAT, captureDump, streamDump } from "../deploy/backup/backup.ts";
import { manifestProblems, verifyBackupFiles } from "../deploy/backup/restore-check.ts";
import { waitHealthy, type Clock, type RunResult } from "../deploy/lib.ts";
import type { OwnedDir } from "../deploy/owned.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

describe("streams", () => {
	let scratch: OwnedDir | undefined;
	let work: string;
	before(async () => {
		scratch = await makeScratch("af-test-streams-");
		work = scratch.path;
	});
	after(async () => {
		await disposeScratch(scratch);
	});

	// A child process that writes `text` to its standard output and exits with `code` (stands in for pg_dump).
	const fakeDump = (text: string, code: number, stderr = "") =>
		spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

	it("streamDump hashes and counts what it moves, with backpressure", async () => {
		const chunks: Buffer[] = [];
		// A sink that accepts one chunk at a time and signals slowly: the source must wait for it.
		let inFlight = 0;
		let maxInFlight = 0;
		const sink = new Writable({
			highWaterMark: 1,
			write(chunk: Buffer, _encoding, callback) {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				chunks.push(chunk);
				setImmediate(() => {
					inFlight -= 1;
					callback();
				});
			},
		});
		const parts = Array.from({ length: 50 }, (_, i) => Buffer.from(`part ${i}\n`));
		const digest = await streamDump(Readable.from(parts), sink);
		const all = Buffer.concat(parts);
		assert.equal(digest.bytes, all.length);
		assert.equal(digest.sha256, createHash("sha256").update(all).digest("hex"));
		assert.equal(Buffer.concat(chunks).equals(all), true);
		assert.equal(maxInFlight, 1, "the writer must never be given a second chunk before it finished the first");
	});

	it("streamDump rejects when the writable fails, and destroys the source", async () => {
		const source = Readable.from(Array.from({ length: 20 }, () => Buffer.alloc(1024)));
		const sink = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("disk full"));
			},
		});
		await assert.rejects(streamDump(source, sink), /disk full/);
		assert.equal(source.destroyed, true);
	});

	it("streamDump destroys an endless source and the sink when the writable fails", async () => {
		// An endless source ends only if the pipeline destroys it (a plain pipe would leave it open and paused).
		const source = new Readable({
			read() {
				this.push(Buffer.alloc(1024));
			},
		});
		const sink = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("disk full"));
			},
		});
		await assert.rejects(streamDump(source, sink), /disk full/);
		assert.equal(source.destroyed, true, "the source must be destroyed");
	});

	it("streamDump destroys the sink and rejects when the source fails midway", async () => {
		const source = new Readable({
			read() {
				this.push(Buffer.alloc(16));
				this.destroy(new Error("pipe broke"));
			},
		});
		const sink = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		await assert.rejects(streamDump(source, sink), /pipe broke/);
		assert.equal(sink.destroyed, true, "the sink must be destroyed, not left open");
	});

	it("captureDump keeps the file of a dump that ends well", async () => {
		const file = join(work, "ok.dump");
		const digest = await captureDump(fakeDump("PGDMP-bytes", 0), file);
		assert.equal(digest.bytes, "PGDMP-bytes".length);
		assert.deepEqual((await readdir(work)).filter((f) => f === "ok.dump"), ["ok.dump"]);
	});

	it("captureDump removes the partial file and fails when the dump process dies after writing", async () => {
		const file = join(work, "died.dump");
		await assert.rejects(captureDump(fakeDump("some bytes", 3, "boom"), file), /pg_dump failed \(exit 3\).*boom/);
		assert.equal((await readdir(work)).includes("died.dump"), false);
	});

	it("captureDump fails on an empty output even with exit 0, and leaves no file", async () => {
		const file = join(work, "empty.dump");
		await assert.rejects(captureDump(fakeDump("", 0), file), /no output/);
		assert.equal((await readdir(work)).includes("empty.dump"), false);
	});

	it("captureDump never overwrites or removes a file that already exists", async () => {
		const file = join(work, "taken.dump");
		await writeFile(file, "someone else's data");
		await assert.rejects(captureDump(fakeDump("x", 0), file), /EEXIST/);
		assert.deepEqual((await readdir(work)).filter((f) => f === "taken.dump"), ["taken.dump"]);
	});
});

describe("waitHealthy with a fake clock", () => {
	// The clock only moves when the code sleeps, so no test waits for real time.
	const fakeClock = (): Clock & { slept: number } => {
		let now = 1_000_000;
		const clock = {
			slept: 0,
			now: () => now,
			sleep: async (milliseconds: number) => {
				now += milliseconds;
				clock.slept += milliseconds;
			},
		};
		return clock;
	};
	const answer = (code: number, stdout: string): RunResult => ({ code, stdout, stderr: "" });

	it("returns when the status turns healthy after some polls", async () => {
		const clock = fakeClock();
		const statuses = ["starting\n", "starting\n", "healthy\n"];
		let polls = 0;
		await waitHealthy("c", 60_000, { clock, inspect: async () => answer(0, statuses[polls++] ?? "healthy\n") });
		assert.equal(polls, 3);
		assert.ok(clock.slept > 0 && clock.slept < 60_000);
	});

	it("gives up at the deadline and names the last status", async () => {
		const clock = fakeClock();
		await assert.rejects(waitHealthy("c", 5_000, { clock, inspect: async () => answer(0, "starting\n") }), /not healthy after 5000 ms \(last status: starting\)/);
		assert.ok(clock.slept >= 5_000);
	});

	it("fails at once when the container is gone", async () => {
		const clock = fakeClock();
		await assert.rejects(waitHealthy("c", 60_000, { clock, inspect: async () => ({ code: 1, stdout: "", stderr: "No such object" }) }), /container c is gone/);
		assert.equal(clock.slept, 0);
	});
});

describe("backup files are validated by content", () => {
	let scratch: OwnedDir | undefined;
	let work: string;
	const dumpBytes = Buffer.from("PGDMP fake dump content");
	const sum = createHash("sha256").update(dumpBytes).digest("hex");
	const goodManifest = () => ({
		format: MANIFEST_FORMAT,
		createdAt: "2026-01-01T00:00:00.000Z",
		database: "agent_factory",
		serverVersion: "16.9",
		serverVersionNum: 160009,
		image: "pgvector/pgvector:test",
		dump: { file: "af-20260101T000000Z-aabbccdd.dump", sha256: sum, bytes: dumpBytes.length },
		rowCounts: { "public.t": 3 },
		foreignKeys: [],
	});

	before(async () => {
		scratch = await makeScratch("af-test-validate-");
		work = scratch.path;
	});
	after(async () => {
		await disposeScratch(scratch);
	});

	// Writes a complete backup of the given pieces into its own directory and returns the manifest path.
	const make = async (name: string, parts: { manifest?: object; dump?: Buffer; sidecar?: string | null } = {}): Promise<string> => {
		// A fresh private directory per call (exclusive mkdtemp), so nothing of an earlier call needs removing here.
		const dir = await mkdtemp(join(work, `${name}-`));
		const manifest = parts.manifest ?? goodManifest();
		const file = (manifest as { dump: { file: string } }).dump.file;
		await writeFile(join(dir, file), parts.dump ?? dumpBytes);
		if (parts.sidecar !== null) await writeFile(join(dir, `${file}.sha256`), parts.sidecar ?? `${sum}  ${file}\n`);
		const manifestPath = join(dir, file.replace(/\.dump$/, ".manifest.json"));
		await writeFile(manifestPath, JSON.stringify(manifest));
		return manifestPath;
	};

	it("accepts a complete, consistent backup", async () => {
		const verified = await verifyBackupFiles(await make("good"));
		assert.equal(verified.manifest.dump.sha256, sum);
	});

	it("rejects a missing checksum file", async () => {
		await assert.rejects(verifyBackupFiles(await make("nosum", { sidecar: null })), /checksum file missing/);
	});

	it("rejects an empty or malformed checksum file", async () => {
		for (const [name, sidecar] of [["emptysum", ""], ["onespace", `${sum} x.dump\n`], ["short", "abc  x.dump\n"], ["nonewline", `${sum}  af-20260101T000000Z-aabbccdd.dump`], ["upper", `${sum.toUpperCase()}  af-20260101T000000Z-aabbccdd.dump\n`]] as const) {
			await assert.rejects(verifyBackupFiles(await make(name, { sidecar })), /checksum file/, name);
		}
	});

	it("rejects a checksum file that names another dump or holds another value", async () => {
		await assert.rejects(verifyBackupFiles(await make("othername", { sidecar: `${sum}  other.dump\n` })), /name/);
		await assert.rejects(verifyBackupFiles(await make("othersum", { sidecar: `${"0".repeat(64)}  af-20260101T000000Z-aabbccdd.dump\n` })), /checksum mismatch/);
	});

	it("rejects an empty dump and a dump that differs from the manifest", async () => {
		await assert.rejects(verifyBackupFiles(await make("emptydump", { dump: Buffer.alloc(0) })), /empty/);
		await assert.rejects(verifyBackupFiles(await make("changed", { dump: Buffer.from("PGDMP other content!!!!") })), /checksum mismatch|size/);
	});

	it("rejects a manifest that is not valid JSON or lacks fields", async () => {
		const bad = join(work, "badjson");
		await import("node:fs/promises").then((fs) => fs.mkdir(bad, { recursive: true }));
		const badName = "af-20260101T000000Z-aabbccdd.manifest.json";
		await writeFile(join(bad, badName), "{ nope");
		await assert.rejects(verifyBackupFiles(join(bad, badName)), /not valid JSON/);
		const manifest = goodManifest();
		for (const [field, value] of [["format", "other"], ["createdAt", "yesterday"], ["serverVersion", ""], ["image", 5], ["database", "postgres"]] as const) {
			assert.notDeepEqual(manifestProblems({ ...manifest, [field]: value }), [], field);
		}
		assert.notDeepEqual(manifestProblems({ ...manifest, dump: { ...manifest.dump, sha256: "xyz" } }), []);
		assert.notDeepEqual(manifestProblems({ ...manifest, dump: { ...manifest.dump, file: "../evil.dump" } }), []);
		assert.notDeepEqual(manifestProblems({ ...manifest, dump: { ...manifest.dump, bytes: -1 } }), []);
		assert.notDeepEqual(manifestProblems({ ...manifest, rowCounts: { "public.t": -2 } }), []);
		assert.notDeepEqual(manifestProblems({ ...manifest, foreignKeys: [{ table: "t" }] }), []);
		assert.deepEqual(manifestProblems(manifest), []);
	});
});
