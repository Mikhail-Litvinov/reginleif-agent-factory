import { runBroker } from "./windows-spawn.js";

// Entry of the process that WMI creates for `spawnDetachedWindows` when the caller's job forbids breakaway; its one
// argument is the path of the spec file.
const SPEC_ARGUMENT_INDEX = 2;

if (import.meta.main) {
	const spec = Bun.argv[SPEC_ARGUMENT_INDEX];
	process.exitCode = spec === undefined ? 1 : await runBroker(spec);
}
