// The TLS proxy of deploy/compose.yml (package 49), run for real against the Temporal server of the same stack: the method
// allowlist per certificate identity (security.md S6), mTLS on the Temporal port, the API reachable only through the proxy
// (T25) and no activity task of the queue `control` (D28).
//
// One stack per file (Postgres, temporal-setup, temporal, proxy) on its own project name, ports and secrets directory. The
// certificates are issued per run into the secrets directory (and a second CA into a scratch directory, for the "other CA"
// proof); both are removed by the cleanups, no key outlives the run. The API is the real createApiServer started in this
// process on the loopback, the way api/main.ts binds it; the proxy container reaches it through host.docker.internal.
//
// Each refusal also has its control: the same call over the direct loopback connection (the owner identity, no proxy) is
// answered by the server itself, so a refusal is not a broken harness (testing.md, S6).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundle } from "@temporalio/worker";
import { createApiServer } from "../api/server.ts";
import { writeCa, writeServer, writeWorker } from "../deploy/proxy/certs.ts";
import { freePort, realClock, run, runChecked, stackArgs, stackEnv, waitHealthy } from "../deploy/lib.ts";
import { Cleanups, newBenchStackInfo } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";
import { workflowsPathOf } from "./temporal/bench.ts";
import { echoActivities } from "./temporal/echo-activities.ts";

const NAMESPACE = "af-proxy-test";
const WORKER_QUEUE = "af-proxy-worker";
const REFUSAL_QUEUE = "af-proxy-refusals";
const CONTROL_QUEUE = "control";
// 1 day: the shortest retention the server accepts for a namespace (temporal-compose.test.ts, same source).
const RETENTION_SECONDS = 24 * 60 * 60;
// 4 minutes: the start of the stack (initdb, schema step, server, proxy), measured at about 60 s in temporal-compose.test.ts;
// the bound is four times that for a loaded machine.
const START_MS = 240_000;
const TEST_MS = 300_000;
const TEMPORAL_SERVICE = "/temporal.api.workflowservice.v1.WorkflowService/";
// grpc status codes (grpc/grpc status codes doc): PERMISSION_DENIED is what the proxy answers to a method outside the allowlist.
const PERMISSION_DENIED = 7;
// The lifecycle stage ADMITTED of an update (temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage): the call returns
// when the server has accepted the request into its queue, so it needs no worker.
const UPDATE_STAGE_ADMITTED = 1;
// Task queue kind NORMAL (temporal.api.enums.v1.TaskQueueKind).
const QUEUE_KIND_NORMAL = 1;
// 10 s: the deadline of the owner's control poll; the workflow task is already queued, so the poll answers at once (observed 0.1 s).
const POLL_DEADLINE_MS = 10_000;

interface Identity {
	readonly crt: Buffer;
	readonly key: Buffer;
}

describe("tls proxy", { concurrency: false }, () => {
	const cleanups = new Cleanups();
	let info: Awaited<ReturnType<typeof newBenchStackInfo>>;
	let env: Record<string, string>;
	let directAddress = "";
	let proxyTemporalPort = 0;
	let proxyApiPort = 0;
	let apiPort = 0;
	let caCert = Buffer.alloc(0);
	let worker: Identity;
	let foreignWorker: Identity;
	let echoBundle: WorkflowBundle;
	let remoteBundle: WorkflowBundle;
	let proxyContainer = "";

	const composeChecked = (...args: string[]) => runChecked("docker", stackArgs(info, ...args), { env });
	const containerOf = async (service: string): Promise<string> => {
		const ids = (await runChecked("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${info.project}`, "--filter", `label=com.docker.compose.service=${service}`])).split(/\s+/).filter(Boolean);
		assert.equal(ids.length, 1, `one ${service} container expected, found ${ids.length}`);
		return ids[0] as string;
	};
	const healthy = async (container: string): Promise<void> => {
		try {
			await waitHealthy(container, START_MS);
		} catch (error) {
			const log = await run("docker", ["logs", "--tail", "80", container]);
			throw new Error(`${(error as Error).message}\n--- log of ${container} ---\n${log.stdout}${log.stderr}`);
		}
	};
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
	// The access log of the proxy: what it decided about each call, by identity and path.
	const proxyLog = async (): Promise<string> => {
		const log = await runChecked("docker", ["logs", proxyContainer]);
		const both = await run("docker", ["logs", proxyContainer]);
		return `${log}${both.stderr}`;
	};
	const direct = (): Promise<Connection> => Connection.connect({ address: directAddress });
	const throughProxy = (who: Identity | undefined, ca: Buffer = caCert): Promise<Connection> =>
		Connection.connect({
			address: `127.0.0.1:${proxyTemporalPort}`,
			tls: { serverNameOverride: "localhost", serverRootCACertificate: ca, ...(who === undefined ? {} : { clientCertPair: { crt: who.crt, key: who.key } }) },
			connectTimeout: 10_000,
		});
	// The grpc status of a call: "ok" when it succeeded, else the numeric code the server or the proxy answered.
	const statusOf = async (call: () => Promise<unknown>): Promise<number | "ok"> => {
		try {
			await call();
			return "ok";
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (typeof code === "number") return code;
			throw error;
		}
	};
	// Whether the proxy's own RBAC filter refused the call (its message), as opposed to the server answering PERMISSION_DENIED itself
	// (the server does that for an update on a namespace without updates enabled).
	const rbacRefused = async (call: () => Promise<unknown>): Promise<boolean> => {
		try {
			await call();
			return false;
		} catch (error) {
			return (error as { message?: unknown }).message === "RBAC: access denied";
		}
	};
	const identityFrom = async (dir: string, id: string): Promise<Identity> => ({ crt: await readFile(join(dir, `worker-${id}.crt`)), key: await readFile(join(dir, `worker-${id}.key`)) });

	before(async () => {
		info = await newBenchStackInfo(cleanups);
		const temporalPort = await freePort();
		proxyTemporalPort = await freePort();
		proxyApiPort = await freePort();
		apiPort = await freePort();
		directAddress = `127.0.0.1:${temporalPort}`;
		env = { ...stackEnv(info), AF_TEMPORAL_PORT: String(temporalPort), AF_PROXY_TEMPORAL_PORT: String(proxyTemporalPort), AF_PROXY_API_PORT: String(proxyApiPort), AF_API_PORT: String(apiPort) };

		// Certificates: the proxy's CA, server and one worker in the secrets directory (removed with it); a worker of a second,
		// unrelated CA in a scratch directory of its own.
		const proxyDir = join(info.secretsDir, "proxy");
		writeCa(proxyDir);
		writeServer(proxyDir, ["localhost", "127.0.0.1"]);
		const workerDir = join(info.secretsDir, "worker-out");
		writeWorker(proxyDir, "w1", workerDir);
		caCert = await readFile(join(proxyDir, "ca.crt"));
		worker = await identityFrom(workerDir, "w1");
		let otherDir: Awaited<ReturnType<typeof makeScratch>> | undefined;
		cleanups.add(() => disposeScratch(otherDir));
		otherDir = await makeScratch("af-proxy-other-ca-");
		writeCa(otherDir.path);
		writeWorker(otherDir.path, "w1");
		foreignWorker = await identityFrom(otherDir.path, "w1");

		echoBundle = await bundleWorkflowCode({ workflowsPath: workflowsPathOf(new URL("./temporal/echo-workflow.ts", import.meta.url).href) });
		remoteBundle = await bundleWorkflowCode({ workflowsPath: workflowsPathOf(new URL("./temporal/remote-echo-workflow.ts", import.meta.url).href) });

		// The API of the host on the loopback, started before the proxy is used (the container resolves the host when it connects).
		const api = createApiServer({ tokens: { byHash: async () => undefined } });
		cleanups.add(() => api.close());
		await api.listen(apiPort);

		try {
			await cleanups.track(composeChecked("up", "-d", "proxy"));
		} catch (error) {
			const log = await run("docker", stackArgs(info, "logs", "--no-color"), { env });
			throw new Error(`${(error as Error).message}\n--- compose logs ---\n${log.stdout}${log.stderr}`);
		}
		await healthy(await containerOf("temporal"));
		proxyContainer = await containerOf("proxy");
		await healthy(proxyContainer);
		await eventually(async () => {
			const connection = await direct();
			try {
				await connection.workflowService.registerNamespace({ namespace: NAMESPACE, workflowExecutionRetentionPeriod: { seconds: RETENTION_SECONDS as never } });
			} finally {
				await connection.close();
			}
		});
		await eventually(async () => {
			const connection = await direct();
			try {
				await connection.workflowService.describeNamespace({ namespace: NAMESPACE });
			} finally {
				await connection.close();
			}
		});
	});

	after(async () => {
		await cleanups.runAll();
	});

	it("a worker certificate is refused StartWorkflowExecution, UpdateWorkflowExecution, PollWorkflowTaskQueue and the decision route; the owner's direct calls are answered by the server", { timeout: TEST_MS }, async () => {
		const owner = await direct();
		const viaProxy = await throughProxy(worker);
		try {
			const workflowId = "refusal-target";
			const start = (service: Connection, id: string) =>
				service.workflowService.startWorkflowExecution({ namespace: NAMESPACE, workflowId: id, workflowType: { name: "Anything" }, taskQueue: { name: REFUSAL_QUEUE, kind: QUEUE_KIND_NORMAL }, requestId: `request-${id}-${Math.random()}` });
			// Controls first: the owner's identity reaches the server and the server itself answers.
			assert.equal(await statusOf(() => start(owner, workflowId)), "ok", "control: the owner starts a workflow");
			const update = (service: Connection) =>
				service.workflowService.updateWorkflowExecution({
					namespace: NAMESPACE,
					workflowExecution: { workflowId },
					request: { meta: { updateId: `update-${Math.random()}`, identity: "test" }, input: { name: "anything" } },
					waitPolicy: { lifecycleStage: UPDATE_STAGE_ADMITTED as never },
				});
			assert.equal(await rbacRefused(() => update(owner)), false, "control: the owner's update is not refused by the proxy");
			const pollDecision = (service: Connection) => service.workflowService.pollWorkflowTaskQueue({ namespace: NAMESPACE, taskQueue: { name: REFUSAL_QUEUE, kind: QUEUE_KIND_NORMAL }, identity: "test" });
			// The server wants a deadline on a long poll ("Context timeout is not set"); the workflow task of the start is ready at once.
				const controlPoll = await owner.withDeadline(Date.now() + POLL_DEADLINE_MS, () => pollDecision(owner)).then(() => "ok", (error: Error) => error.message);
				assert.equal(controlPoll, "ok", "control: the owner polls the workflow task the start made");
			const respondDecision = (service: Connection) => service.workflowService.respondWorkflowTaskCompleted({ namespace: NAMESPACE, taskToken: Buffer.from("not-a-task-token"), identity: "test" });
			const controlRespond = await statusOf(() => respondDecision(owner));
			assert.notEqual(controlRespond, PERMISSION_DENIED, "control: the server answers a decision itself");
			assert.notEqual(controlRespond, 14, "control: the server is reachable");

			// The four refusals of the worker certificate.
			assert.equal(await statusOf(() => start(viaProxy, "refused-start")), PERMISSION_DENIED, "StartWorkflowExecution");
			assert.equal(await statusOf(() => update(viaProxy)), PERMISSION_DENIED, "UpdateWorkflowExecution");
			assert.equal(await statusOf(() => pollDecision(viaProxy)), PERMISSION_DENIED, "PollWorkflowTaskQueue");
			assert.equal(await statusOf(() => respondDecision(viaProxy)), PERMISSION_DENIED, "RespondWorkflowTaskCompleted");
			// The refused start created nothing.
			assert.notEqual(await statusOf(() => owner.workflowService.describeWorkflowExecution({ namespace: NAMESPACE, execution: { workflowId: "refused-start" } })), "ok", "the refused workflow does not exist");
			// The proxy is the one that refused: its log names the identity and every path.
			for (const method of ["StartWorkflowExecution", "UpdateWorkflowExecution", "PollWorkflowTaskQueue", "RespondWorkflowTaskCompleted"]) {
				await eventually(async () => {
					assert.match(await proxyLog(), new RegExp(`peer=spiffe://agent-factory/worker/w1 path=${TEMPORAL_SERVICE.replaceAll(".", "\\.")}${method} .*grpc=PermissionDenied`), `the proxy log holds the refusal of ${method}`);
				});
			}
		} finally {
			await viaProxy.close();
			await owner.close();
		}
	});

	it("a worker certificate polls and completes an activity task of its queue through the proxy", { timeout: TEST_MS }, async () => {
		const owner = await direct();
		const nativeDirect = await NativeConnection.connect({ address: directAddress });
		const nativeProxy = await NativeConnection.connect({ address: `127.0.0.1:${proxyTemporalPort}`, tls: { serverNameOverride: "localhost", serverRootCACertificate: caCert, clientCertPair: { crt: worker.crt, key: worker.key } } });
		try {
			// The workflow worker is the owner's (direct); it runs no activity. The activity worker is the proxy's client.
			const workflowWorker = await Worker.create({ connection: nativeDirect, namespace: NAMESPACE, taskQueue: WORKER_QUEUE, workflowBundle: remoteBundle, enableNonLocalActivities: false });
			const activityWorker = await Worker.create({ connection: nativeProxy, namespace: NAMESPACE, taskQueue: WORKER_QUEUE, activities: echoActivities });
			const client = new Client({ connection: owner, namespace: NAMESPACE });
			const result = await workflowWorker.runUntil(activityWorker.runUntil(client.workflow.execute("RemoteEchoWorkflow", { taskQueue: WORKER_QUEUE, workflowId: "remote-echo", args: [{ text: "through-the-proxy" }] })));
			assert.deepEqual(result, { echoed: "echo:through-the-proxy" });
			const history = await client.workflow.getHandle("remote-echo").fetchHistory();
			const scheduled = (history.events ?? []).filter((event) => event.activityTaskScheduledEventAttributes != null);
			assert.equal(scheduled.length, 1, "the step ran as an ordinary activity task");
			assert.equal(scheduled[0]?.activityTaskScheduledEventAttributes?.taskQueue?.name, WORKER_QUEUE);
			// Envoy writes an access-log line when the stream ends, a moment after the client saw the answer.
			for (const method of ["PollActivityTaskQueue", "RespondActivityTaskCompleted"]) {
				await eventually(async () => {
					assert.match(await proxyLog(), new RegExp(`peer=spiffe://agent-factory/worker/w1 path=${TEMPORAL_SERVICE.replaceAll(".", "\\.")}${method} .*grpc=OK`), `the proxy log holds the allowed ${method}`);
				});
			}
		} finally {
			await nativeProxy.close();
			await nativeDirect.close();
			await owner.close();
		}
	});

	it("no activity task of the queue `control` exists: the server steps are local activities (D28)", { timeout: TEST_MS }, async () => {
		const owner = await direct();
		const nativeDirect = await NativeConnection.connect({ address: directAddress });
		try {
			const controlWorker = await Worker.create({ connection: nativeDirect, namespace: NAMESPACE, taskQueue: CONTROL_QUEUE, workflowBundle: echoBundle, activities: echoActivities, enableNonLocalActivities: false });
			const client = new Client({ connection: owner, namespace: NAMESPACE });
			const result = await controlWorker.runUntil(client.workflow.execute("EchoWorkflow", { taskQueue: CONTROL_QUEUE, workflowId: "control-echo", args: [{ text: "control" }] }));
			assert.deepEqual(result, { echoed: "echo:control", patched: true });
			const events = (await client.workflow.getHandle("control-echo").fetchHistory()).events ?? [];
			assert.equal(events.filter((event) => event.activityTaskScheduledEventAttributes != null).length, 0, "no ActivityTaskScheduled event in the history");
			assert.ok(events.some((event) => event.markerRecordedEventAttributes != null), "control: the step is there, as a marker of a local activity");
		} finally {
			await nativeDirect.close();
			await owner.close();
		}
	});

	it("a connection without a client certificate is refused", { timeout: TEST_MS }, async () => {
		const good = await throughProxy(worker);
		try {
			assert.equal(await statusOf(() => good.workflowService.getSystemInfo({})), "ok", "control: the worker certificate is let in");
		} finally {
			await good.close();
		}
		await assert.rejects(async () => {
			const connection = await throughProxy(undefined);
			try {
				await connection.workflowService.getSystemInfo({});
			} finally {
				await connection.close();
			}
		}, "the proxy must drop a connection with no client certificate");
	});

	it("a certificate of another CA is refused", { timeout: TEST_MS }, async () => {
		await assert.rejects(async () => {
			const connection = await throughProxy(foreignWorker);
			try {
				await connection.workflowService.getSystemInfo({});
			} finally {
				await connection.close();
			}
		}, "the proxy must drop a certificate its CA did not sign");
	});

	it("T25: the API answers through the proxy and on no other address", { timeout: TEST_MS }, async () => {
		// Through the proxy: TLS with the proxy's certificate and no client certificate; the answer is the API's own (it sets X-Request-Id).
		const response = await new Promise<{ status: number; type: string; requestId: string | undefined }>((resolve, reject) => {
			const req = httpsRequest({ host: "127.0.0.1", port: proxyApiPort, path: "/nothing", method: "GET", ca: caCert, servername: "localhost" }, (res) => {
				res.resume();
				res.once("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), requestId: res.headers["x-request-id"] as string | undefined }));
			});
			req.once("error", reject);
			req.end();
		});
		assert.ok(response.status >= 400 && response.status < 500, `the API answers an unknown path with a client error, got ${response.status}`);
		assert.match(response.type, /application\/problem\+json/);
		assert.ok(response.requestId, "the API's own X-Request-Id header came back through the proxy");

		// The API port accepts on the loopback only; the host's other addresses are refused (a 0.0.0.0 bind would accept).
		assert.equal(await accepts("127.0.0.1", apiPort), true);
		for (const host of externalAddresses()) assert.equal(await accepts(host, apiPort), false, `${host} must not accept a connection on the API port ${apiPort}`);
		// The proxy's own ports are published on the loopback (AF_PROXY_BIND default), not on every address.
		const bindings = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", proxyContainer])) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
		assert.deepEqual(bindings, { "7234/tcp": [{ HostIp: "127.0.0.1", HostPort: String(proxyTemporalPort) }], "8443/tcp": [{ HostIp: "127.0.0.1", HostPort: String(proxyApiPort) }] });
		// Temporal itself is on the loopback and not on the proxy's external address (the proxy is the only entrance).
		const server = await containerOf("temporal");
		const temporalBindings = JSON.parse(await runChecked("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", server])) as Record<string, Array<{ HostIp: string }>>;
		for (const list of Object.values(temporalBindings)) for (const binding of list) assert.equal(binding.HostIp, "127.0.0.1");
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
