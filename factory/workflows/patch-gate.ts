// PatchGate (temporal.md "Versioning": until Worker Versioning is confirmed, audit 8.5, a code change on a live path
// uses patched(), later removed by deprecatePatch()). Workflow-side module: it imports only @temporalio/workflow, so
// it bundles with the workflow code. Lanes call these two functions and never the SDK ones directly, so every patch id
// of the system is a name in one registry (`PATCHES`) and one audit target.
import { deprecatePatch, patched } from "@temporalio/workflow";

/** Patch ids still in live histories. A lane adds an id here when it changes a live path, removes it after deprecation. */
export const PATCHES = [] as const satisfies readonly string[];
export type PatchId = (typeof PATCHES)[number] | (string & {});

export interface PatchGate {
	/** True for executions that run new code (new, or replay of a history that recorded the marker). */
	readonly isNew: (id: PatchId) => boolean;
	/** Step 2 of the removal: all open histories are past the patched code; marker still accepted on replay. */
	readonly deprecate: (id: PatchId) => void;
}

export const patchGate: PatchGate = {
	isNew: (id) => patched(id),
	deprecate: (id) => deprecatePatch(id),
};
