import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { migrate } from "../db/migrate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..");
const MIGRATIONS_DIR = join(PACKAGE_ROOT, "db", "migrations");
const MODULES_DOC = join(REPOSITORY_ROOT, "docs", "agent-factory", "modules.md");
const DATABASE_DOC = join(REPOSITORY_ROOT, "docs", "agent-factory", "database.md");
const JOURNAL = join(MIGRATIONS_DIR, "meta", "_journal.json");

interface MigrationFile {
	name: string;
	number: number;
	sql: string;
}

const migrationFiles = async (): Promise<MigrationFile[]> => {
	const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql"));
	const files = await Promise.all(names.map(async (name) => {
		const match = /^(\d{4,})_[^/\\]+\.sql$/.exec(name);
		assert.ok(match, `invalid migration filename: ${name}`);
		return {
			name,
			number: Number(match[1]),
			sql: await readFile(join(MIGRATIONS_DIR, name), "utf8"),
		};
	}));
	return files.sort((a, b) => a.number - b.number);
};

const documentedTableOrder = (modules: string): Map<number, string[]> => {
	const result = new Map<number, string[]>();
	for (const line of modules.split(/\r?\n/)) {
		const match = /^\| (\d{4}) \| ([^|]+) \|/.exec(line);
		if (!match) continue;
		const number = Number(match[1]);
		const tables = (match[2] as string).split(",").map((part) => part.trim().replace(/\s*\([^)]*\)/g, "")).filter(Boolean);
		result.set(number, tables);
	}
	return result;
};

const createdTablesInOrder = (sql: string): string[] =>
	[...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:public|"public")\.)?"?([a-z][a-z0-9_]*)"?/gi)].map((match) => (match[1] as string).toLowerCase());

const validateForeignKeyTargets = (files: MigrationFile[]): void => {
	const earlierTables = new Set<string>();
	for (const file of files) {
		const currentTables = new Set<string>();
		for (const statement of file.sql.split(";")) {
			const creates = [...statement.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:public|"public")\.)?"?([a-z][a-z0-9_]*)"?/gi)];
			for (const create of creates) currentTables.add((create[1] as string).toLowerCase());
			const alterations = [...statement.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:(?:public|"public")\.)?"?([a-z][a-z0-9_]*)"?/gi)];
			for (const alter of alterations) {
				const target = (alter[1] as string).toLowerCase();
				assert.ok(earlierTables.has(target) || currentTables.has(target), `${file.name}: ALTER TABLE target ${target} is not created earlier`);
			}
			const references = [...statement.matchAll(/\bREFERENCES\s+(?:(?:public|"public")\.)?"?([a-z][a-z0-9_]*)"?/gi)];
			for (const reference of references) {
				const target = (reference[1] as string).toLowerCase();
				assert.ok(earlierTables.has(target) || currentTables.has(target), `${file.name}: foreign key target ${target} is not created earlier or in the same migration`);
			}
			for (const create of creates) currentTables.add((create[1] as string).toLowerCase());
		}
		for (const table of createdTablesInOrder(file.sql)) earlierTables.add(table);
	}
};

const directoryContents = async (directory: string): Promise<Map<string, string>> => {
	const entries = await readdir(directory, { withFileTypes: true });
	const contents = new Map<string, string>();
	for (const entry of entries) {
		if (entry.isDirectory()) {
			for (const [name, text] of await directoryContents(join(directory, entry.name))) contents.set(`${entry.name}/${name}`, text);
		} else {
			contents.set(entry.name, await readFile(join(directory, entry.name), "utf8"));
		}
	}
	return contents;
};

describe("migration order", () => {
	it("applies every migration in numeric order and records the file and journal set", async () => {
		const bench = await databaseBench(import.meta.url);
		const files = await migrationFiles();
		const journal = JSON.parse(await readFile(JOURNAL, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
		assert.deepEqual(files.map((file) => file.number), files.map((_, index) => index + 1));
		assert.deepEqual(journal.entries.map((entry) => entry.idx), files.map((file) => file.number));
		assert.deepEqual(journal.entries.map((entry) => `${entry.tag}.sql`), files.map((file) => file.name));

		const applied = await migrate({ url: bench.migratorUrl });
		assert.deepEqual(applied, files.map((file) => file.name));
		const sql = connectBench(bench.migratorUrl);
		try {
			const history = await sql<{ number: number; name: string }[]>`SELECT number, name FROM public.af_migrations ORDER BY number`;
			assert.deepEqual(history, files.map((file) => ({ number: file.number, name: file.name })));
		} finally {
			await sql.end();
		}
	});

	it("matches documented table membership and creates foreign key targets in order", async () => {
		const files = await migrationFiles();
		const documented = documentedTableOrder(await readFile(MODULES_DOC, "utf8"));
		for (const file of files) {
			const expected = documented.get(file.number);
			assert.ok(expected, `${file.name} has no migration order row in modules.md`);
			assert.deepEqual(
				[...createdTablesInOrder(file.sql)].sort(),
				[...expected].sort(),
				`${file.name} table membership differs from modules.md`,
			);
		}
		validateForeignKeyTargets(files);
		const databaseDoc = await readFile(DATABASE_DOC, "utf8");
		assert.match(databaseDoc, /Creation order\. Every foreign key target exists when the key is created/);
	});

	it("regenerates migrations without changing the committed SQL, journal, or snapshots", async () => {
		const scratch = await makeScratch("af-migration-order-");
		try {
			const copiedMigrations = join(scratch.path, "migrations");
			await mkdir(copiedMigrations, { recursive: true });
			for (const entry of await readdir(MIGRATIONS_DIR, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					const destination = join(copiedMigrations, entry.name);
					await mkdir(destination, { recursive: true });
					for (const child of await readdir(join(MIGRATIONS_DIR, entry.name))) {
						await copyFile(join(MIGRATIONS_DIR, entry.name, child), join(destination, child));
					}
				} else await copyFile(join(MIGRATIONS_DIR, entry.name), join(copiedMigrations, entry.name));
			}
			const configPath = join(scratch.path, "drizzle.config.ts");
			await writeFile(configPath, `export default { dialect: "postgresql", schema: ${JSON.stringify(join(PACKAGE_ROOT, "db", "schema", "*.ts").replaceAll("\\", "/"))}, out: ${JSON.stringify(copiedMigrations.replaceAll("\\", "/"))} };\n`);
			const before = await directoryContents(copiedMigrations);
			const drizzleCli = join(PACKAGE_ROOT, "node_modules", "drizzle-kit", "bin.cjs");
			const generated = spawnSync(process.execPath, [drizzleCli, "generate", "--config", configPath], {
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
			});
			assert.equal(generated.error, undefined, generated.error?.message);
			assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
			assert.deepEqual(await directoryContents(copiedMigrations), before, "drizzle-kit generated changes; schema and migration snapshots diverge");
		} finally {
			await disposeScratch(scratch);
		}
	});
});
