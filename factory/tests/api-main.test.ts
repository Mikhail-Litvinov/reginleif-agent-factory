import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { assertLoopback, loadApiConfig, NonLoopbackRefused, READY_PREFIX } from "../api/main.ts";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { connectBench, databaseBench } from "./database-bench.ts";
import { benchStack } from "./helpers.ts";

const mainPath = new URL("../api/main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const benchPromise = databaseBench(import.meta.url);
const children = new Set<ChildProcess>();

after(() => { for (const child of children) child.kill(); });

test("a non-loopback address is refused without TLS and names the docs", async () => {
	for (const host of ["0.0.0.0", "192.168.1.5", "::", "example.test"]) {
		assert.throws(() => assertLoopback(host), NonLoopbackRefused);
		await assert.rejects(loadApiConfig({ AF_API_HOST: host }), (error: Error) => error instanceof NonLoopbackRefused && /security\.md T25/.test(error.message));
	}
	assert.doesNotThrow(() => assertLoopback("127.0.0.1"));
	assert.doesNotThrow(() => assertLoopback("localhost"));
});

test("the process exits with status 2 on a non-loopback address before touching the database", async () => {
	const child = spawn(process.execPath, [mainPath], { env: { ...process.env, AF_API_HOST: "0.0.0.0" }, stdio: ["ignore", "pipe", "pipe"] });
	children.add(child);
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	assert.equal(code, 2);
});

let owner = "";
before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	const client = connectBench(bench.migratorUrl);
	try {
		const ownerId = randomUUID();
		await client`INSERT INTO owners (id, name) VALUES (${ownerId}, 'owner')`;
		const prefix = randomBytes(6).toString("hex");
		const secret = randomBytes(24).toString("base64url");
		await createRepo(drizzle(client)).tokens.create({ id: randomUUID(), name: "owner", role: "owner", prefix, tokenHash: createHash("sha256").update(secret).digest("hex"), ownerId });
		owner = `Bearer afk_${prefix}_${secret}`;
	} finally { await client.end(); }
});

test("the real process serves a public and an authenticated route and stops cleanly on SIGTERM", async () => {
	const bench = await benchPromise;
	const stack = await benchStack();
	// The password stays in the file of the stack's secrets directory; only the directory, port and database name go through the environment.
	const child = spawn(process.execPath, [mainPath], {
		env: { ...process.env, AF_SECRETS_DIR: stack.secretsDir, AF_PG_PORT: String(stack.port), AF_PG_DATABASE: bench.database, AF_API_PORT: "0" },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	children.add(child);
	let stderr = "";
	child.stderr!.on("data", (chunk) => { stderr += chunk; });
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	const base = await new Promise<string>((resolve, reject) => {
		const lines = createInterface({ input: child.stdout! });
		lines.on("line", (line) => { if (line.startsWith(READY_PREFIX)) resolve(line.slice(READY_PREFIX.length)); });
		void exited.then(() => reject(new Error(`process exited before it was ready: ${stderr}`)));
	});
	// The public route that has a handler today (GET /system/health is a later package, tests/handler-coverage.test.ts): enrolment
	// needs no token, reads the database as af_api, and answers a code that does not exist with 401 unauthenticated.
	const enroll = await fetch(`${base}/devices/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "no-such-code", name: "probe" }) });
	assert.equal(enroll.status, 401);
	assert.equal(((await enroll.json()) as { code: string }).code, "unauthenticated");
	assert.equal((await fetch(`${base}/tokens`)).status, 401);
	assert.equal((await fetch(`${base}/tokens`, { headers: { authorization: owner } })).status, 200);
	// Windows cannot deliver SIGTERM to a process (the system ends it at once, no handler runs), so there the supervisor message
	// "af-api-stop" over the IPC channel takes the same stop path.
	if (process.platform === "win32") child.send("af-api-stop");
	else child.kill("SIGTERM");
	assert.deepEqual(await exited, { code: 0, signal: null });
});
