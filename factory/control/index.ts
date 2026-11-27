import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { SettingsReader } from "../db/repo/settings.ts";
import type { TaskEventWriter } from "../db/repo/decisions.ts";
import { createRepo } from "../db/repo/index.ts";

export interface ControlConnectionOptions {
	readonly secretsDir?: string;
	readonly port?: number;
}

export const controlDatabaseUrl = async ({ secretsDir = process.env.AF_SECRETS_DIR, port = Number(process.env.AF_PG_PORT ?? "55432") }: ControlConnectionOptions = {}): Promise<string> => {
	if (!secretsDir) throw new Error("AF_SECRETS_DIR is required");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AF_PG_PORT must be an integer from 1 to 65535");
	const password = (await readFile(join(secretsDir, "af_control"), "utf8")).replace(/[\r\n]+$/, "");
	if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error("invalid af_control secret");
	return `postgres://af_control:${encodeURIComponent(password)}@127.0.0.1:${port}/agent_factory`;
};

export const connectControl = async (options: ControlConnectionOptions = {}) => {
	const client = postgres(await controlDatabaseUrl(options));
	const db = drizzle(client);
	return { client, db, repo: createRepo(db), close: () => client.end() };
};

export const LoadSettings = (settings: SettingsReader, keys: readonly string[]): Promise<Record<string, unknown>> => settings.snapshot(keys);

export interface PersistTaskEventInput {
	id: string;
	taskId: string;
	runId: string | null;
	eventType: string;
	actorType: "owner" | "worker" | "workflow" | "system";
	actorId: string | null;
	payload: unknown;
	correlationId: string | null;
	dedupeKey: string;
}

export const PersistTaskEvent = (taskEvents: TaskEventWriter, event: PersistTaskEventInput) => taskEvents.persist(event);
