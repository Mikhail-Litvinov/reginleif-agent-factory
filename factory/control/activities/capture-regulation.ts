import { and, eq, isNull } from "drizzle-orm";
import type { Repo } from "../../db/repo/index.ts";
import { taskRuns } from "../../db/schema/runs.ts";

type Db = { update: (table: typeof taskRuns) => any };

export type CaptureRegulationResult =
	| { readonly captured: true; readonly regulationVersionId: string; readonly alreadySet: boolean }
	| { readonly captured: false; readonly reason: "no_active_regulation" };

/**
 * registry-capture: a run stores the regulation version that was active at its start (task_runs.regulation_version_id),
 * so a later review knows which regulation the run worked under. The value is written once: a repeated attempt of the
 * activity, or a later call after the active version changed, never overwrites it (`WHERE regulation_version_id IS NULL`).
 * With no active version the run keeps NULL and the result says so; the workflow decides what that means.
 */
export const createCaptureRegulationVersion = (deps: { readonly repo: Pick<Repo, "registry">; readonly db: Db; readonly getRun: (id: string) => Promise<{ regulationVersionId: string | null } | undefined> }) =>
	async (input: { readonly runId: string }): Promise<CaptureRegulationResult> => {
		const run = await deps.getRun(input.runId);
		if (!run) throw new RangeError(`run ${input.runId} does not exist`);
		if (run.regulationVersionId) return { captured: true, regulationVersionId: run.regulationVersionId, alreadySet: true };
		const active = await deps.repo.registry.regulations.active();
		if (!active) return { captured: false, reason: "no_active_regulation" };
		const rows = await deps.db.update(taskRuns).set({ regulationVersionId: active.id })
			.where(and(eq(taskRuns.id, input.runId), isNull(taskRuns.regulationVersionId))).returning({ id: taskRuns.id });
		if (rows.length === 1) return { captured: true, regulationVersionId: active.id, alreadySet: false };
		// Lost a race with another attempt: the stored value is the answer.
		const stored = await deps.getRun(input.runId);
		return { captured: true, regulationVersionId: stored!.regulationVersionId!, alreadySet: true };
	};
