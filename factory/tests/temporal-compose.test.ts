// The Temporal services of deploy/compose.yml (package 48), run for real: the one-shot schema step, the server and a
// workflow of the SDK pinned in package.json (1.27.0) on the server image pinned in compose.yml. The tests assert what the
// docs promise: a workflow's history survives `docker compose restart` of the server, survives a host reboot (the
// containers are all started at once, with no order, the way docker restarts them after a reboot) and a stop followed by a
// new `up`; the published ports are on 127.0.0.1 only; the UI does not start by default; no password is in any environment
// or argument list of the containers.
//
// One stack per file (Postgres, temporal-setup, temporal), on its own project name, ports and secrets directory. Waits are
// on conditions (a health status, a namespace that answers), polled with the clock of deploy/lib.ts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundle } from "@temporalio/worker";
import { freePort, realClock, run, runChecked, stackArgs, stackEnv, waitHealthy } from "../deploy/lib.ts";
import { Cleanups, newBenchStackInfo } from "./helpers.ts";
import { workflowsPathOf } from "./temporal/bench.ts";
import { echoActivities } from "./temporal/echo-activities.ts";

const NAMESPACE = "af-compose-test";
const TASK_QUEUE = "af-compose-test";
// 1 day: the shortest retention the server accepts for a namespace (its dynamic config bound
// `limit.maxRetention`/minimum of 1 day, Temporal docs "Namespace" > "Retention Period").
// The generated type of an int64 is `Long`; protobufjs encodes a plain number the same, so the call casts it.
const RETENTION_SECONDS = 24 * 60 * 60;
// 4 minutes: the first start of the stack pulls nothing (images are present) but runs initdb, the schema step and the server
// start; measured on this machine at about 60 s, the bound is four times that for a loaded machine.
const START_MS = 240_000;
const TEST_MS = 300_000;

describe("temporal compose services", { concurrency: false }, () => {
	const cleanups = new Cleanups();
	let info: Awaited<ReturnType<typeof newBenchStackInfo>>;
	let env: Record<string, string>;
	let temporalPort = 0;
	let address = "";
	let bundle: WorkflowBundle;
	let secret = "";

	const compose = (...args: string[]) => run("docker", stackArgs(info, ...args), { env });
	const composeChecked = (...args: string[]) => runChecked("docker", stackArgs(info, ...args), { env });
	const containerOf = async (service: string, all = false): Promise<string> => {
		const ids = (await runChecked("docker", ["ps", ...(all ? ["-a"] : []), "-q", "--filter", `label=com.docker.compose.project=${info.project}`, "--filter", `label=com.docker.compose.service=${service}`])).split(/\s+/).filter(Boolean);
		assert.equal(ids.length, 1, `one ${service} container expected, found ${ids.length}`);
		return ids[0] as string;
	};
	// Waits until the healthcheck says healthy; a failure carries the container's log, which is what explains it.
	const healthy = async (container: string): Promise<void> => {
		try {
			await waitHealthy(container, START_MS);
		} catch (error) {
			const log = await run("docker", ["logs", "--tail", "80", container]);
			throw new Error(`${(error as Error).message}\n--- log of ${container} ---\n${log.stdout}${log.stderr}`);
		}
	};
	// Polls `check` until it returns without throwing; rethrows the last error at the deadline.
	const eventually = async (check: () => Promise<void>, timeoutMs = 60_000): Promise<void> => {
		const deadline = realClock.now() + timeoutMs;
		for (;;) {
			try {
				return await check();
			} catch (error) {
				if (realClock.now() >= deadline) throw error;
				await realClock.sleep(300);
			}
		}
	};
	const withClient = async <T>(body: (client: Client) => Promise<T>): Promise<T> => {
		const connection = await Connection.connect({ address });
		try {
			return await body(new Client({ connection, namespace: NAMESPACE }));
		} finally {
			await connection.close();
		}
	};
	// Runs the echo workflow `id` to its end with a worker of the factory's test bench (the production worker's options).
	const runEcho = async (id: string, text: string): Promise<{ echoed: string; patched: boolean }> => {
		const nativeConnection = await NativeConnection.connect({ address });
		try {
			const worker = await Worker.create({ connection: nativeConnection, namespace: NAMESPACE, taskQueue: TASK_QUEUE, workflowBundle: bundle, activities: echoActivities, enableNonLocalActivities: false });
			return await worker.runUntil(withClient((client) => client.workflow.execute("EchoWorkflow", { taskQueue: TASK_QUEUE, workflowId: id, args: [{ text }] }))) as { echoed: string; patched: boolean };
		} finally {
			await nativeConnection.close();
		}
	};
	// What the server holds of a finished workflow: its status, its result and the number of events of its history.
	const readBack = (id: string) =>
		eventually(async () => undefined).then(() =>
			withClient(async (client) => {
				const handle = client.workflow.getHandle(id);
				const description = await handle.describe();
				const history = await handle.fetchHistory();
				return { status: description.status.name, result: await handle.result(), events: history.events?.length ?? 0 };
			}),
		);
	// The server answers on the namespace again after a restart (the gRPC port opens after the healthcheck's HTTP port).
	const namespaceAnswers = (): Promise<void> =>
		eventually(async () => {
			await withClient((client) => client.connection.workflowService.describeNamespace({ namespace: NAMESPACE }).then(() => undefined));
		});

	// `compose stop` returns about a quarter of a second before the daemon records the exit, and a start in that window is
	// silently ignored (docs/agent-factory/deployment.md, "Stop and start"): wait for every container to be exited first.
	const stopAll = async (): Promise<void> => {
		const ids = [await containerOf("temporal"), await containerOf("postgres")];
		await composeChecked("stop");
		for (const id of ids) await runChecked("docker", ["wait", id]);
	};

	let firstEvents = 0;

	before(async () => {
		info = await newBenchStackInfo(cleanups);
		temporalPort = await freePort();
		address = `127.0.0.1:${temporalPort}`;
		env = { ...stackEnv(info), AF_TEMPORAL_PORT: String(temporalPort) };
		bundle = await bundleWorkflowCode({ workflowsPath: workflowsPathOf(new URL("./temporal/echo-workflow.ts", import.meta.url).href) });
		secret = (await readFile(join(info.secretsDir, "af_temporal"), "utf8")).trim();
		try {
			await cleanups.track(composeChecked("up", "-d", "temporal"));
		} catch (error) {
			// A failed schema step explains itself in its own log; the compose error only names the exit code.
			const log = await compose("logs", "--no-color", "temporal-setup", "temporal");
			throw new Error(`${(error as Error).message}\n--- compose logs ---\n${log.stdout}${log.stderr}`);
		}
		await healthy(await containerOf("temporal"));
		// Compose creates no namespace: the application registers its own (the test does what the application's start does).
		await eventually(async () => {
			await withClient((client) => client.connection.workflowService.registerNamespace({ namespace: NAMESPACE, workflowExecutionRetentionPeriod: { seconds: RETENTION_SECONDS as never } }).then(() => undefined));
		});
		await namespaceAnswers();
	});

	after(async () => {
		await cleanups.runAll();
	});

	it("the schema step ran to its end and a workflow of SDK 1.27.0 completes on the server", { timeout: TEST_MS }, async () => {
		const setup = await containerOf("temporal-setup", true);
		const state = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .State}}", setup])) as { Status: string; ExitCode: number };
		assert.deepEqual({ status: state.Status, exit: state.ExitCode }, { status: "exited", exit: 0 });
		assert.deepEqual(await runEcho("compose-first", "one"), { echoed: "echo:one", patched: true });
		const back = await readBack("compose-first");
		assert.equal(back.status, "COMPLETED");
		firstEvents = back.events;
		assert.ok(firstEvents > 0);
	});

	it("the history survives `docker compose restart` of the server", { timeout: TEST_MS }, async () => {
		const server = await containerOf("temporal");
		await composeChecked("restart", "temporal");
		await healthy(server);
		await namespaceAnswers();
		assert.deepEqual(await readBack("compose-first"), { status: "COMPLETED", result: { echoed: "echo:one", patched: true }, events: firstEvents });
	});

	it("the history survives a reboot: every container stopped, then all started at once with no order", { timeout: TEST_MS }, async () => {
		const server = await containerOf("temporal");
		const database = await containerOf("postgres");
		await stopAll();
		// docker after a host reboot starts what has a restart policy, in no order: the server (restart: unless-stopped) is up
		// while Postgres is still starting, and must wait for it, not give up. temporal-setup (restart: "no") is not started.
		await runChecked("docker", ["start", server, database]);
		await healthy(database);
		await healthy(server);
		await namespaceAnswers();
		assert.deepEqual(await readBack("compose-first"), { status: "COMPLETED", result: { echoed: "echo:one", patched: true }, events: firstEvents });
		assert.deepEqual(await runEcho("compose-after-reboot", "two"), { echoed: "echo:two", patched: true });
	});

	it("the history survives a stop and a new `up` that runs the schema step again on the schema it made", { timeout: TEST_MS }, async () => {
		const setup = await containerOf("temporal-setup", true);
		const before = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .State}}", setup])) as { StartedAt: string };
		await stopAll();
		await composeChecked("up", "-d", "temporal");
		await healthy(await containerOf("temporal"));
		await namespaceAnswers();
		const after = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .State}}", await containerOf("temporal-setup", true)])) as { StartedAt: string; ExitCode: number; Status: string };
		assert.notEqual(after.StartedAt, before.StartedAt, "the schema step ran again");
		assert.deepEqual({ status: after.Status, exit: after.ExitCode }, { status: "exited", exit: 0 });
		assert.deepEqual(await readBack("compose-first"), { status: "COMPLETED", result: { echoed: "echo:one", patched: true }, events: firstEvents });
		assert.deepEqual(await runEcho("compose-after-up", "three"), { echoed: "echo:three", patched: true });
	});

	it("the server port is on 127.0.0.1 only, and the web UI does not start by default", { timeout: TEST_MS }, async () => {
		const server = await containerOf("temporal");
		const ports = (await runChecked("docker", ["port", server])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		assert.deepEqual(ports, [`7233/tcp -> 127.0.0.1:${temporalPort}`]);
		const bindings = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", server])) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
		assert.deepEqual(bindings, { "7233/tcp": [{ HostIp: "127.0.0.1", HostPort: String(temporalPort) }] });
		assert.equal(await accepts("127.0.0.1", temporalPort), true, "the loopback address accepts");
		// A connection to the host's own non-loopback address is not accepted (a published 0.0.0.0 would accept it).
		for (const host of externalAddresses()) assert.equal(await accepts(host, temporalPort), false, `${host} must not accept a connection on ${temporalPort}`);
		const ui = (await runChecked("docker", ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${info.project}`, "--filter", "label=com.docker.compose.service=temporal-ui"])).trim();
		assert.equal(ui, "", "no temporal-ui container without the profile");
	});

	it("no password is in the environment or the argument list of the Temporal containers", { timeout: TEST_MS }, async () => {
		assert.ok(secret.length >= 16, "the af_temporal secret is a real password");
		for (const service of ["temporal", "temporal-setup"]) {
			const container = await containerOf(service, true);
			const environment = await runChecked("docker", ["inspect", "--format", "{{json .Config.Env}}", container]);
			const entry = await runChecked("docker", ["inspect", "--format", "{{json .Config.Entrypoint}} {{json .Config.Cmd}}", container]);
			assert.ok(!environment.includes(secret) && !entry.includes(secret), `${service}: the password is in its configuration`);
		}
		const server = await containerOf("temporal");
		const cmdlines = await runChecked("docker", ["exec", server, "sh", "-c", "cat /proc/[0-9]*/cmdline"]);
		assert.ok(!cmdlines.includes(secret), "the password is in an argument list of the running server");
		const environments = await runChecked("docker", ["exec", "-u", "temporal", server, "sh", "-c", 'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null; done; true']);
			assert.ok(environments.length > 8, "some process environment was read as the temporal user");
		assert.ok(!environments.includes(secret), "the password is in the environment of a running process");
	});
});

// The IPv4 addresses of the host that are not loopback.
const externalAddresses = (): string[] =>
	Object.values(networkInterfaces())
		.flatMap((list) => list ?? [])
		.filter((entry) => entry.family === "IPv4" && !entry.internal)
		.map((entry) => entry.address);

// Whether a TCP connection to host:port is accepted. 3 s bounds a dropped packet only: a closed port of the host's own
// address is refused at once.
const accepts = (host: string, port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = net.connect({ host, port });
		socket.setTimeout(3_000);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
