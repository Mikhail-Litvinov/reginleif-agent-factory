// The API process: `node factory/api/main.ts` (docs/agent-factory/deployment.md, "Starting the API").
// Settings come from the environment, secrets from files, the same way factory/db/migrate.ts does it; no password is ever
// read from an environment variable (deployment.md, "No password in any environment").
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { integerValue, reportCliFailure, UsageError } from "../deploy/cli-args.ts";
import { createRepo, type Repo } from "../db/repo/index.ts";
import { createLogger } from "../lib/log.ts";
import { createEmbedderClient, httpEmbedderTransport } from "../registry/embedder-client.ts";
import { defaultEmbeddingModel, type Embedder } from "../registry/search.ts";
import { createApiServer } from "./server.ts";
import { registerAllHandlers } from "./handlers/register-all.ts";

// Cleartext is served on loopback only; every other address takes TLS (api.md "Authentication", security.md T25 and the
// row "Switch on a non-loopback bind of the API", client.md "Network"). The TLS proxy (F/deploy/proxy/, deployment.md "TLS
// proxy") is the external entrance and reaches this process on the loopback, so the process itself never binds anything else
// and a non-loopback address is refused outright. createApiServer().listen binds 127.0.0.1 whatever the setting says,
// so the only accepted spellings are the ones that mean exactly that address.
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];

export class NonLoopbackRefused extends UsageError {
	constructor(host: string) {
		super(`AF_API_HOST ${host} is not loopback: the API is served on 127.0.0.1 only and the external entrance is the TLS proxy (docs/agent-factory/security.md T25, "Switch on a non-loopback bind of the API": refused; see deployment.md "TLS proxy")`);
	}
}

export const assertLoopback = (host: string): void => {
	if (!LOOPBACK_HOSTS.includes(host)) throw new NonLoopbackRefused(host);
};

export interface ApiConfig {
	readonly host: string;
	// 0 asks the system for a free port (tests); the real port is printed in the ready line.
	readonly port: number;
	readonly databaseUrl: string;
	readonly embedderUrl?: string;
	// The model version the background pass embeds toward; undefined means "the setting registry.embeddingModel, else the pinned default".
	readonly embeddingTarget?: string;
	readonly reembedBatch: number;
	readonly reembedIntervalMs: number;
	readonly stopTimeoutMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

// Defaults. The docs fix none of these three numbers, so they are chosen here and overridable by the setting named next to each:
// 8787 is a free port next to neither PostgreSQL (55432, AF_PG_PORT) nor the embedder (8088, AF_EMBEDDER_PORT);
// a batch of 16 texts keeps one embedder request small (the container truncates each text at 8192 tokens, deploy/embedder/server.py);
// a pass every 60 seconds is the pace of a record being captured by a person, and a pass with nothing pending is one cheap query.
// A stop is bounded by 10 seconds: longer than one registry search or one re-embedding batch round trip on loopback, far
// below the 30 seconds a supervisor usually waits before it kills a service.
const DEFAULT_PORT = "8787";
const DEFAULT_REEMBED_BATCH = "16";
const DEFAULT_REEMBED_INTERVAL_MS = "60000";
const DEFAULT_STOP_TIMEOUT_MS = "10000";

export const loadApiConfig = async (env: Env): Promise<ApiConfig> => {
	const host = env.AF_API_HOST ?? "127.0.0.1";
	assertLoopback(host);
	const secretsDir = env.AF_SECRETS_DIR;
	if (!secretsDir) throw new Error("AF_SECRETS_DIR is required");
	// The API connects as its own role af_api (database.md, roles); it cannot delete and cannot change its own schema.
	const password = (await readFile(join(secretsDir, "af_api"), "utf8")).replace(/[\r\n]+$/, "");
	if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error("invalid af_api secret");
	const pgPort = integerValue("AF_PG_PORT", env.AF_PG_PORT ?? "55432", 1, 65535);
	const database = env.AF_PG_DATABASE ?? "agent_factory";
	if (!/^[A-Za-z0-9_]+$/.test(database)) throw new UsageError("AF_PG_DATABASE may hold letters, digits and underscores only");
	return {
		host,
		port: integerValue("AF_API_PORT", env.AF_API_PORT ?? DEFAULT_PORT, 0, 65535),
		databaseUrl: `postgres://af_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}`,
		embedderUrl: env.AF_EMBEDDER_URL || undefined,
		embeddingTarget: env.AF_EMBEDDER_TARGET_VERSION || undefined,
		reembedBatch: integerValue("AF_REEMBED_BATCH", env.AF_REEMBED_BATCH ?? DEFAULT_REEMBED_BATCH, 1, 1000),
		reembedIntervalMs: integerValue("AF_REEMBED_INTERVAL_MS", env.AF_REEMBED_INTERVAL_MS ?? DEFAULT_REEMBED_INTERVAL_MS, 1, 86_400_000),
		stopTimeoutMs: integerValue("AF_API_STOP_TIMEOUT_MS", env.AF_API_STOP_TIMEOUT_MS ?? DEFAULT_STOP_TIMEOUT_MS, 1, 600_000),
	};
};

const modelSetting = async (repo: Repo): Promise<string> => {
	const value = (await repo.settings.snapshot(["registry.embeddingModel"]))["registry.embeddingModel"];
	return typeof value === "string" ? value : defaultEmbeddingModel;
};

export interface RunningApi {
	readonly port: number;
	stop(): Promise<void>;
}

// Opens the pool, starts the server and the re-embedding loop, and returns the handle that stops all three.
export const startApi = async (config: ApiConfig, log = createLogger()): Promise<RunningApi> => {
	const sql = postgres(config.databaseUrl);
	let api: ReturnType<typeof createApiServer> | undefined;
	let stopLoop: () => void = () => {};
	try {
		// A wrong password or a missing database ends the start here, before anything listens.
		await sql`SELECT 1`;
		const repo = createRepo(drizzle(sql));
		let embed: Embedder | undefined;
		if (config.embedderUrl) {
			const client = createEmbedderClient(repo, httpEmbedderTransport(config.embedderUrl));
			// An unreachable embedder or an unexpected answer is degraded search, never a failed request (search.ts).
			embed = async (text) => {
				try { return (await client.embed([text], await modelSetting(repo)))[0]; }
				catch (error) { log.warn(`embedder unavailable, search is degraded: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
			};
			// An explicit AF_EMBEDDER_TARGET_VERSION pins the target; otherwise every pass reads the setting, the way query embedding does.
				const target = config.embeddingTarget ?? (() => modelSetting(repo));
			stopLoop = client.startBackground(target, config.reembedBatch, config.reembedIntervalMs, {
				onError: (error) => log.warn(`re-embedding pass failed, the next pass tries again: ${error instanceof Error ? error.message : String(error)}`),
			});
		}
		api = createApiServer({ tokens: repo.tokens, logger: log });
		registerAllHandlers(api, repo, { embed });
		const address = await api.listen(config.port);
		const server = api;
		let stopping: Promise<void> | undefined;
		return {
			port: address.port,
			// Order: stop taking requests and finish the running ones, stop the loop, close the pool (postgres.js waits for a running query up to `timeout` seconds, then cuts it).
			stop: () => stopping ??= (async () => {
				try { await server.close(); }
				finally {
					stopLoop();
					await sql.end({ timeout: Math.ceil(config.stopTimeoutMs / 1000) });
				}
			})(),
		};
	} catch (error) {
		stopLoop();
		await sql.end({ timeout: 1 }).catch(() => {});
		throw error;
	}
};

export interface SignalSource {
	once(event: string, listener: () => void): unknown;
	on(event: string, listener: (message: unknown) => void): unknown;
}

// A stop request arrives as SIGINT or SIGTERM. Windows cannot deliver SIGTERM to a process (the system ends it at once), so a
// supervisor that started the process with an IPC channel can send the message "af-api-stop" instead.
export const installShutdown = (source: SignalSource, stop: () => Promise<void>, onDone: (code: number) => void): void => {
	let started = false;
	const run = () => {
		if (started) return;
		started = true;
		stop().then(() => onDone(0), (error) => { console.error(`stop failed: ${error instanceof Error ? error.message : String(error)}`); onDone(1); });
	};
	source.once("SIGINT", run);
	source.once("SIGTERM", run);
	source.on("message", (message) => { if (message === "af-api-stop") run(); });
};

export const READY_PREFIX = "af-api ready ";

if (import.meta.main) {
	try {
		const config = await loadApiConfig(process.env);
		const running = await startApi(config);
		const deadline = (code: number) => {
			process.exitCode = code;
			// An open IPC channel (a supervisor's, or the test's on Windows) would keep the process alive after the stop.
			if (process.connected) process.disconnect();
			// The stop is bounded: when something keeps the process alive past the limit, it ends with status 1 (limit: AF_API_STOP_TIMEOUT_MS).
			setTimeout(() => process.exit(1), config.stopTimeoutMs).unref();
		};
		installShutdown(process, () => running.stop(), deadline);
		console.log(`${READY_PREFIX}http://127.0.0.1:${running.port}`);
	} catch (error) { reportCliFailure(error, "api failed to start", "usage: node factory/api/main.ts (settings: AF_SECRETS_DIR, AF_PG_PORT, AF_PG_DATABASE, AF_API_HOST, AF_API_PORT, AF_EMBEDDER_URL)"); }
}
