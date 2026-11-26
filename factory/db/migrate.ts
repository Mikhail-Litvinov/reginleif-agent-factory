import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { integerValue, parseCliArgs, reportCliFailure } from "../deploy/cli-args.ts";

// Stable, application-specific two-part session lock; held on the same connection throughout the run.
const LOCK_NAMESPACE = 0x41464d47;
const LOCK_ID = 1;
const DEFAULT_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

interface Migration { number: number; name: string; checksum: string; sql: string }
export interface MigrateOptions { url: string; migrationsDir?: string; onApplied?: (name: string) => void }

const loadMigrations = async (directory: string): Promise<Migration[]> => {
	const names = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
	const files = await Promise.all(names.map(async (name): Promise<Migration> => {
		const match = /^(\d{4,})_[^/\\]+\.sql$/.exec(name);
		if (!match) throw new Error(`invalid migration filename: ${name}`);
		const number = Number(match[1]);
		if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error(`invalid migration number: ${name}`);
		const bytes = await readFile(join(directory, name));
		return { number, name, checksum: createHash("sha256").update(bytes).digest("hex"), sql: bytes.toString("utf8") };
	}));
	files.sort((a, b) => a.number - b.number);
	for (let i = 0; i < files.length; i++) {
		const current = files[i]!;
		if (i > 0 && current.number === files[i - 1]!.number) throw new Error(`duplicate migration number: ${current.number}`);
		if (current.number !== i + 1) throw new Error(`migration number gap before ${current.name}`);
	}
	return files;
};

export const migrate = async ({ url, migrationsDir = DEFAULT_DIR, onApplied }: MigrateOptions): Promise<string[]> => {
	const sql = postgres(url, { max: 1 });
	try {
		await sql`SELECT pg_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_ID})`;
		try {
			const files = await loadMigrations(migrationsDir);
			await sql`CREATE TABLE IF NOT EXISTS public.af_migrations (
				number integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
			)`;
			const history = await sql<{ number: number; name: string; sha256: string }[]>`SELECT number, name, sha256 FROM public.af_migrations ORDER BY number`;
			for (let i = 0; i < history.length; i++) {
				const row = history[i]!;
				const file = files[i];
				if (row.number !== i + 1) throw new Error(`applied migration history is out of order at ${row.number}`);
				if (!file || file.number !== row.number) throw new Error(`applied migration file missing from history: ${row.name}`);
				if (file.name !== row.name) throw new Error(`applied migration name changed: ${row.name}`);
				if (file.checksum !== row.sha256) throw new Error(`applied migration checksum changed: ${row.name}`);
			}
			const applied: string[] = [];
			for (const file of files.slice(history.length)) {
				await sql.begin(async (tx) => {
					await tx.unsafe(file.sql);
					await tx`INSERT INTO public.af_migrations (number, name, sha256) VALUES (${file.number}, ${file.name}, ${file.checksum})`;
				});
				applied.push(file.name);
				onApplied?.(file.name);
			}
			return applied;
		} finally { await sql`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_ID})`; }
	} finally { await sql.end(); }
};

if (import.meta.main) {
	try {
		parseCliArgs(process.argv.slice(2), { flags: {} });
		const secretsDir = process.env.AF_SECRETS_DIR;
		if (!secretsDir) throw new Error("AF_SECRETS_DIR is required");
		const password = (await readFile(join(secretsDir, "af_migrator"), "utf8")).replace(/[\r\n]+$/, "");
		if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error("invalid af_migrator secret");
		const port = integerValue("AF_PG_PORT", process.env.AF_PG_PORT ?? "55432", 1, 65535);
		const url = `postgres://af_migrator:${encodeURIComponent(password)}@127.0.0.1:${port}/agent_factory`;
		await migrate({ url, onApplied: (name) => console.log(`applied ${name}`) });
	} catch (error) { reportCliFailure(error, "migrate failed", "usage: node factory/db/migrate.ts"); }
}
