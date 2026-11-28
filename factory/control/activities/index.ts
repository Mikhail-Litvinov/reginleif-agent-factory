import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Repo } from "../../db/repo/index.ts";
import { MachineLiveness, type MachineLivenessInput } from "./machine-liveness.ts";
import { LoadSettings } from "./load-settings.ts";
import { PersistTaskEvent, type PersistTaskEventInput } from "./persist-task-event.ts";
import { ReadDecision, type ReadDecisionInput } from "./read-decision.ts";
import { RecordDecisionOutcome, type RecordDecisionOutcomeInput } from "./record-decision-outcome.ts";

export { MachineLiveness, type MachineLivenessInput, type MachineLivenessResult } from "./machine-liveness.ts";
export { LoadSettings } from "./load-settings.ts";
export { PersistTaskEvent, type PersistTaskEventInput } from "./persist-task-event.ts";
export { ReadDecision, type ReadDecisionInput, type ReadDecisionResult } from "./read-decision.ts";
export { RecordDecisionOutcome, type RecordDecisionOutcomeInput, type RecordDecisionOutcomeResult } from "./record-decision-outcome.ts";
export { DecisionNotFoundError, isRefusalCode, refusalCodes, TASK_CLOSED, type RefusalCode } from "./refusal.ts";

// The local activities bound to a repo (connected as af_control), keyed by their ActivityCatalog names. Each takes one
// argument, as Temporal passes it. Timeouts come from the settings `act.<Name>.*` through the ActivityCatalog.
export const createControlActivities = (repo: Repo, db: PostgresJsDatabase<any>) => ({
	ReadDecision: (input: ReadDecisionInput) => ReadDecision(repo, input),
	RecordDecisionOutcome: (input: RecordDecisionOutcomeInput) => RecordDecisionOutcome(repo, input),
	PersistTaskEvent: (event: PersistTaskEventInput) => PersistTaskEvent(repo.taskEvents, event),
	LoadSettings: (input: { keys: readonly string[] }) => LoadSettings(repo.settings, input.keys),
	// Package 57: one liveness pass; it needs the database handle for its per-worker transactions.
	MachineLiveness: (input: MachineLivenessInput) => MachineLiveness(db, input),
});

export type ControlActivities = ReturnType<typeof createControlActivities>;
