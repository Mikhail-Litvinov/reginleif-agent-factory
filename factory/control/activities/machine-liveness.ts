// MachineLiveness (package 57, MachineLivenessWorkflow): one pass over the `workers` rows. A worker whose last heartbeat is
// older than `liveness.silenceSeconds` becomes `offline` and gets one `worker_offline` notice (dedup key
// `worker_offline:<id>`). A worker that is offline and heartbeats again becomes `online` (or `outdated` when its contract is
// outside the supported range, never plain `online`) and its open notice is resolved,
// so every outage has its own notice. Each worker changes in one transaction, guarded by the rowVersion it was read at:
// a heartbeat or another writer in between makes the write stale, and the worker is evaluated again at the next tick.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createRepo } from "../../db/repo/index.ts";
import { StaleVersionError } from "../../db/repo/errors.ts";
import { isContractSupported } from "../../contracts/contract-range.ts";
import { notifications } from "../../db/schema/decisions.ts";
import { LIVENESS_SETTING_KEYS, LIVENESS_SILENCE_KEY, livenessSettingsProblems } from "../liveness-settings.ts";
import { NotifyUser } from "./notify-user.ts";

export interface MachineLivenessInput {
	/** The tick's time as ISO 8601: the workflow's now(), so the activity reads no clock of its own. */
	readonly now: string;
	/** The contract version the Control Worker runs at: a recovering worker on another version is `outdated`, not `online`. */
	readonly contractVersion: number;
}

export interface MachineLivenessResult {
	readonly wentOffline: string[];
	readonly wentOnline: string[];
	/** Workers whose row changed or vanished during the pass; they are evaluated again at the next tick. */
	readonly skipped: string[];
}

export const offlineDedupKey = (workerId: string): string => `worker_offline:${workerId}`;

export const MachineLiveness = async (db: PostgresJsDatabase<any>, input: MachineLivenessInput): Promise<MachineLivenessResult> => {
	const now = new Date(input.now);
	if (Number.isNaN(now.getTime())) throw new Error(`MachineLiveness: now is not a timestamp: ${input.now}`);
	const repo = createRepo(db);
	// The same rule as the Control Worker start: an absent or non-positive setting is an error, never a default.
	const snapshot = await repo.settings.snapshot(LIVENESS_SETTING_KEYS);
	const problems = livenessSettingsProblems(snapshot);
	if (problems.length > 0) throw new Error(`MachineLiveness refused: ${problems.join("; ")}`);
	const silenceMs = Number(snapshot[LIVENESS_SILENCE_KEY]) * 1000;

	const result = { wentOffline: [] as string[], wentOnline: [] as string[], skipped: [] as string[] };
	for (const worker of await repo.workers.list()) {
		// A disabled worker is out of service on purpose: its heartbeats do not decide anything.
		if (worker.status === "disabled") continue;
		// A worker that never sent a heartbeat has been silent since forever.
		const silent = worker.lastSeenAt === null || now.getTime() - worker.lastSeenAt.getTime() > silenceMs;
		const goesOffline = silent && worker.status !== "offline";
		const comesOnline = !silent && worker.status === "offline";
		if (!goesOffline && !comesOnline) continue;
		// Recovery re-derives the status from the worker's own contract version; it never writes `online` over an unsupported one.
		const recoveredStatus = isContractSupported(worker.contractVersion, input.contractVersion) ? "online" : "outdated";

		let applied: boolean;
		try {
			applied = await db.transaction(async (tx) => {
				// The row is written only at the version it was read at; null means the worker no longer exists.
				const changed = await createRepo(tx).workers.update(worker.id, worker.rowVersion, { status: goesOffline ? "offline" : recoveredStatus });
				if (changed === null) return false;
				if (goesOffline) {
					await NotifyUser(tx, { id: randomUUID(), eventType: "worker_offline", dedupKey: offlineDedupKey(worker.id), taskId: null, workerId: worker.id, now });
				} else {
					await tx.update(notifications).set({ state: "resolved", resolvedAt: now, updatedAt: now, rowVersion: sql`${notifications.rowVersion} + 1` })
						.where(and(eq(notifications.dedupKey, offlineDedupKey(worker.id)), eq(notifications.state, "open")));
				}
				return true;
			});
		} catch (error) {
			if (!(error instanceof StaleVersionError)) throw error;
			result.skipped.push(worker.id);
			continue;
		}
		if (!applied) {
			result.skipped.push(worker.id);
			continue;
		}
		(goesOffline ? result.wentOffline : result.wentOnline).push(worker.id);
	}
	return result;
};
