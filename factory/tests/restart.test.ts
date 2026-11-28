// Data survive every way the server container can go away and come back, short of deleting its volume.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { APPLICATION_ROLES } from "../deploy/init-postconditions.ts";
import { psql, realClock, removeOwned, run, runChecked, waitHealthy, findContainer } from "../deploy/lib.ts";
import { compose, createTestStack, type TestStack } from "./helpers.ts";

describe("restart", () => {
	let stack: TestStack;
	let marker = 0;

	// Writes one new row and returns how many rows the table holds now.
	const writeRow = async (): Promise<number> => {
		marker += 1;
		await psql(stack.container, "af_migrator", `INSERT INTO kept VALUES (${marker}, 'row ${marker}');`);
		return marker;
	};
	const rows = async (): Promise<string> => psql(stack.container, "af_backup", "SELECT string_agg(id::text, ',' ORDER BY id) FROM kept;");
	const expected = (): string => Array.from({ length: marker }, (_, i) => i + 1).join(",");

	before(async () => {
		stack = await createTestStack();
		await psql(stack.container, "af_migrator", "CREATE TABLE kept (id int PRIMARY KEY, note text);");
		await writeRow();
	});
	after(async () => {
		await stack?.dispose();
	});

	// Docker never applies a restart policy to a container that a person killed with `docker kill` (it counts as a stop),
	// so a crash is simulated the way it happens: the server's main process dies by itself (SIGQUIT is an immediate
	// shutdown without cleanup, exit code non-zero) and the restart policy must bring the container back.
	it("survive a crash of the server process, which the restart policy brings back", async () => {
		await writeRow();
		const name = stack.container;
		await runChecked("docker", ["exec", name, "sh", "-c", "kill -QUIT 1"]);
		// Wait on the restart counter and then on health, not on a guessed time.
		const deadline = realClock.now() + 120_000;
		let count = "0";
		while (realClock.now() < deadline && count === "0") {
			count = (await run("docker", ["inspect", "--format", "{{.RestartCount}}", name])).stdout.trim();
				// A short pause between polls: back-to-back `docker inspect` processes only load the host the restart needs.
				if (count === "0") await realClock.sleep(200);
		}
		assert.notEqual(count, "0", "the restart policy did not restart the container");
		await waitHealthy(name);
		assert.equal(await rows(), expected());
	});

	it("survive a killed container started again by hand", async () => {
		await writeRow();
		const name = stack.container;
		await runChecked("docker", ["kill", name]);
		// `kill` returns before the daemon records the exit; a `start` in that window is silently ignored and the
		// container then stays exited (measured on stop then start: 11 of 12 cycles; deployment.md "Stop and start").
		await runChecked("docker", ["wait", name]);
		await runChecked("docker", ["start", name]);
		await waitHealthy(name);
		assert.equal(await rows(), expected());
	});

	it("survive a forced recreate of the container", async () => {
		await writeRow();
		const old = stack.container;
		const recreate = await compose(stack, "up", "-d", "--force-recreate", "postgres");
		assert.equal(recreate.code, 0, recreate.stderr);
		stack.container = await findContainer(stack.project);
		assert.notEqual(stack.container, old, "the container must be a new one");
		await waitHealthy(stack.container);
		assert.equal(await rows(), expected());
	});

	it("survive down and up without -v", async () => {
		await writeRow();
		// The container and network of this run go away (by the run's label), the volume stays.
		await removeOwned(stack.runId, { keepVolumes: true });
		const gone = await run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${stack.project}`]);
		assert.equal(gone.stdout.trim(), "", "the container must be gone after the removal");
		const volume = await run("docker", ["volume", "inspect", `${stack.project}_pgdata`]);
		assert.equal(volume.code, 0, "the volume must stay after down");
		const up = await compose(stack, "up", "-d", "postgres");
		assert.equal(up.code, 0, up.stderr);
		stack.container = await findContainer(stack.project);
		await waitHealthy(stack.container);
		assert.equal(await rows(), expected());
	});

	it("the init script does not run again on an existing volume (no second role set, same data)", async () => {
		const count = await psql(stack.container, "af_backup", "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'af\\_%';");
		// The application roles, the bootstrap role and the Temporal role, each made once.
		assert.equal(count, String(APPLICATION_ROLES.length + 2));
		assert.equal(await rows(), expected());
	});
});
