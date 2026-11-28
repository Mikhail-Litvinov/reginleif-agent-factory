// ResolveDependencies (temporal.md "Activities"): local, read only, over live edges only (`removed_at IS NULL`,
// database.md). A dependency is satisfied when its task is ACCEPTED (dependency type `requires_accepted`). Non-retryable
// on a cycle: the workflow turns it into BLOCKED `dependency`.
import { ApplicationFailure } from "@temporalio/activity";
import type { Repo } from "../../db/repo/index.ts";

export const DEPENDENCY_CYCLE = "DependencyCycle";

export interface ResolvedDependencies {
	/** Dependencies not yet ACCEPTED: non-empty means WAITING_DEPENDENCIES. */
	open: string[];
	satisfied: string[];
}

/** Depth-first search over live edges from `taskId`; returns the cycle path (first node repeated at the end) or null. */
export const findCycle = async (edges: (id: string) => Promise<string[]>, taskId: string): Promise<string[] | null> => {
	const done = new Set<string>();
	const walk = async (id: string, path: string[]): Promise<string[] | null> => {
		const at = path.indexOf(id);
		if (at >= 0) return [...path.slice(at), id];
		if (done.has(id)) return null;
		for (const next of await edges(id)) {
			const cycle = await walk(next, [...path, id]);
			if (cycle) return cycle;
		}
		done.add(id);
		return null;
	};
	return walk(taskId, []);
};

export const ResolveDependencies = async (repo: Pick<Repo, "tasks">, { taskId }: { taskId: string }): Promise<ResolvedDependencies> => {
	const cycle = await findCycle(async (id) => (await repo.tasks.dependencies(id)).map((d) => d.dependsOnTaskId), taskId);
	if (cycle) throw ApplicationFailure.nonRetryable(`dependency cycle ${cycle.join(" -> ")}`, DEPENDENCY_CYCLE, cycle);
	const open: string[] = [];
	const satisfied: string[] = [];
	for (const edge of await repo.tasks.dependencies(taskId)) {
		const dependency = await repo.tasks.get(edge.dependsOnTaskId);
		// A deleted or missing dependency task can never become ACCEPTED, so it stays open and the owner sees the wait.
		(dependency?.status === "ACCEPTED" ? satisfied : open).push(edge.dependsOnTaskId);
	}
	return { open, satisfied };
};
