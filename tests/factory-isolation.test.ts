import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// factory/ is its own Node package. Rig's bun test and typecheck must never pick it up: its tests need Docker and Node's runner.
const REPOSITORY_ROOT = join(import.meta.dir, "..");
const FACTORY = "factory";

const bunTestRoot = (): string => {
	const match = /^\s*root\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPOSITORY_ROOT, "bunfig.toml"), "utf8"));
	if (match?.[1] === undefined) throw new Error("bunfig.toml has no test root");
	return match[1];
};

const typecheckInclude = (): string[] => {
	const config = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "tsconfig.json"), "utf8")) as { include?: string[]; exclude?: string[] };
	return config.include ?? [];
};

// True when the pattern could reach into factory/ (a root-level wildcard, factory itself, or a recursive pattern from the root).
export const reachesFactory = (pattern: string): boolean => {
	const normal = pattern.replace(/^\.\//, "");
	return normal === FACTORY || normal.startsWith(`${FACTORY}/`) || normal.startsWith("**") || normal.startsWith("*") || normal === "." || normal === "";
};

describe("factory isolation", () => {
	test("the factory package exists as its own package", () => {
		expect(existsSync(join(REPOSITORY_ROOT, FACTORY, "package.json"))).toBe(true);
	});

	test("bun test runs only the root tests folder", () => {
		const root = bunTestRoot().replace(/^\.\//, "").replace(/\/$/, "");
		expect(root).toBe("tests");
		expect(readdirSync(join(REPOSITORY_ROOT, root)).includes(FACTORY)).toBe(false);
	});

	test("the typecheck includes only src and tests", () => {
		const include = typecheckInclude();
		expect(include.length).toBeGreaterThan(0);
		expect(include.filter(reachesFactory)).toEqual([]);
		for (const pattern of include) expect(/^(\.\/)?(src|tests)\//.test(pattern)).toBe(true);
	});

	test("the guard can fail: it flags every way of reaching factory", () => {
		for (const bad of ["factory/**/*.ts", "./factory", "**/*.ts", "*.ts", ".", ""]) expect(reachesFactory(bad)).toBe(true);
		for (const good of ["src/**/*.ts", "tests/**/*.ts"]) expect(reachesFactory(good)).toBe(false);
	});
});
