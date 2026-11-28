// One scripted fake per machine activity (temporal.md, activity table). Queue names come from the activity catalog, the same
// code the workflow uses to pick a queue, so a fake listens exactly where the workflow sends its calls.
import { allTimeoutKeys, createActivityCatalog } from "../../control/activity-catalog.ts";
import { MACHINE_ACTIVITY_NAMES, type MachineActivityName } from "./contracts.ts";
import { type FakeActivity, scriptedActivity } from "./scripted.ts";

export type MachineFakes = { readonly [K in MachineActivityName]: FakeActivity<K> };

// The catalog refuses a missing or non-positive timeout, so every key gets 1 here. The fakes do not use timeouts (the
// workflow does), so the value only has to be positive; source: createActivityCatalog in control/activity-catalog.ts.
const catalogForQueues = createActivityCatalog(Object.fromEntries(allTimeoutKeys().map((key) => [key, 1])));

/** The fakes of one machine (`machine-<machineId>`, and `machine-<machineId>-gpu` for RunGpuJob). */
export const createMachineFakes = (machineId: string): MachineFakes => {
	const fakes: Record<string, FakeActivity<MachineActivityName>> = {};
	for (const name of MACHINE_ACTIVITY_NAMES) {
		fakes[name] = scriptedActivity(name, catalogForQueues.queue(name, machineId));
	}
	return fakes as unknown as MachineFakes;
};
