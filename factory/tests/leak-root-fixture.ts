// A helper test file for leak-guard.test.ts (it is run by `node --test`, as a real test file is): it registers a cleanup and
// never disposes it itself, like a test file whose own after hook did not run. The root hook that helpers.ts registers must
// run the cleanup, which writes the marker file. It is not a test of its own (the name does not end in .test.ts).
import { writeFile } from "node:fs/promises";
import { it } from "node:test";
import { Cleanups } from "./helpers.ts";

const marker = process.env.AF_FIXTURE_MARKER;
if (!marker) throw new Error("AF_FIXTURE_MARKER is not set");

const cleanups = new Cleanups();
cleanups.add(() => writeFile(marker, "removed"));

it("registers a cleanup and leaves it to the root hook", () => {});
