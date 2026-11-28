import type { TaskEventWriter } from "../../db/repo/decisions.ts";

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
}

// Idempotent by (task_id, dedupe_key): a repeat returns the stored event and writes nothing.
export const PersistTaskEvent = (taskEvents: TaskEventWriter, event: PersistTaskEventInput) => taskEvents.persist(event);
