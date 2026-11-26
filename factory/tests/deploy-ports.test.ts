// Every published port of every service binds to the loopback address only.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { composeFilePath, run, runChecked } from "../deploy/lib.ts";
import type { OwnedDir } from "../deploy/owned.ts";
import { sharedStack } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

interface PortSpec {
	host_ip?: string;
	published?: string | number;
	target: number;
}
interface ComposeConfig {
	services: Record<string, { ports?: PortSpec[] }>;
}

// Returns one problem per published port that is not bound to 127.0.0.1 (a missing host_ip means all interfaces).
export const nonLoopbackPorts = (config: ComposeConfig): string[] => {
	const problems: string[] = [];
	for (const [service, definition] of Object.entries(config.services)) {
		for (const port of definition.ports ?? []) {
			if (port.host_ip !== "127.0.0.1") problems.push(`${service}: port ${port.published ?? "?"}->${port.target} binds to ${port.host_ip ?? "all interfaces"}`);
		}
	}
	return problems;
};

const configOf = async (file: string): Promise<ComposeConfig> =>
	JSON.parse(await runChecked("docker", ["compose", "-f", file, "config", "--format", "json"], { env: { AF_SECRETS_DIR: tmpdir() } })) as ComposeConfig;

describe("published ports", () => {
	let scratch: OwnedDir | undefined;
	let work: string;
	before(async () => {
		scratch = await makeScratch("af-test-ports-");
		work = scratch.path;
	});
	after(async () => {
		await disposeScratch(scratch);
	});

	it("the compose file publishes at least one port and all of them bind to 127.0.0.1", async () => {
		const config = await configOf(composeFilePath());
		const published = Object.values(config.services).flatMap((service) => service.ports ?? []);
		assert.ok(published.length > 0, "no published port found: the check would pass vacuously");
		assert.deepEqual(nonLoopbackPorts(config), []);
	});

	it("the checker fails on a 0.0.0.0 sample and on a port with no address", () => {
		const wide = { services: { db: { ports: [{ target: 5432, published: "5432", host_ip: "0.0.0.0" }] } } };
		assert.equal(nonLoopbackPorts(wide).length, 1);
		const bare = { services: { db: { ports: [{ target: 5432, published: "5432" }] } } };
		assert.equal(nonLoopbackPorts(bare).length, 1);
		const mixed = { services: { a: { ports: [{ target: 1, host_ip: "127.0.0.1" }] }, b: { ports: [{ target: 2, host_ip: "::" }] } } };
		assert.equal(nonLoopbackPorts(mixed).length, 1);
	});

	it("the checker fails on the real compose file with its address changed to 0.0.0.0", async () => {
		const text = (await readFile(composeFilePath(), "utf8")).replace("host_ip: 127.0.0.1", "host_ip: 0.0.0.0");
		const mutant = join(work, "compose.yml");
		await writeFile(mutant, text);
		assert.equal(nonLoopbackPorts(await configOf(mutant)).length, 1);
	});

	it("the running server listens on 127.0.0.1 only, on the port that was asked for", async () => {
		// The run-wide stack, taken only here: the other tests of this file need no server and do not wait for it.
		const stack = await sharedStack();
		try {
			const result = await run("docker", ["port", stack.container]);
			const lines = result.stdout.split(/\r?\n/).filter(Boolean);
			assert.ok(lines.length > 0, result.stderr);
			for (const line of lines) assert.match(line, new RegExp(`-> 127\\.0\\.0\\.1:${stack.port}$`), line);
		} finally {
			await stack.dispose();
		}
	});
});
