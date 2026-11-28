import type { TaskEventWriter, TaskProjection } from "../../db/repo/decisions.ts";

export interface PersistTaskEventInput {
	id: string;
	taskId: string;
	runId: string | null;
	eventType: string;
	actorType: "owner" | "worker" | "workflow" | "system";
	actorId: string | null;
	payload: unknown;
	correlationId: string | null;
	dedupeKey: string;
	/** The task row after this event; written in the event's transaction (temporal.md "The task row follows the workflow"). */
	projection?: TaskProjection;
}

// Idempotent by (task_id, dedupe_key): a repeat returns the stored event and writes nothing (its projection committed with it).
// Returns only the id: a local activity result goes through the JSON payload converter, and the stored row carries a bigint
// `seq` and an xid8, which JSON cannot hold; a failed conversion would retry the activity forever.
export const PersistTaskEvent = async (taskEvents: TaskEventWriter, { projection, ...event }: PersistTaskEventInput): Promise<{ id: string }> => {
	const stored = await taskEvents.persist(event, projection);
	return { id: stored.id };
};
