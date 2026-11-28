// Outbox relay (temporal.md: "a loop in the Control Worker process, not a workflow"). It leases `pending` outbox rows and routes
// each by kind to Temporal (through WorkflowClient) or to an injected effect. Delivery is at least once; one effect comes from
// stable ids: `start_workflow` is refused by the server for a second start, a decision Update carries the decision id (which is
// 1:1 with the row's outbox id) and is deduped by Temporal and by the workflow's `handled` set.
import { randomUUID } from "node:crypto";
import type { notificationRepo } from "../db/repo/client.ts";
import type { OutboxRepository, DecisionRepository } from "../db/repo/decisions.ts";
import type { SettingsReader } from "../db/repo/settings.ts";
import type { TaskRepository } from "../db/repo/tasks.ts";
import type { WorkflowClient } from "./workflow-client.ts";

export const RELAY_SETTING_KEYS = ["relay.leaseSeconds", "relay.retrySeconds", "relay.maxAttempts", "relay.retryMaxSeconds"] as const;
// Chosen, not measured: a lease must outlast one Update round trip to a healthy workflow (an Update is a few activities long),
// and a relay that died is taken over after at most this long. A longer Update is covered by the lease heartbeat below.
export const DEFAULT_LEASE_SECONDS = 60;
// Chosen, not measured: delay before the first retry of a failed delivery (Temporal down, workflow not there yet); it also spaces
// the looks of the sent sweep at a `sent` row whose effect is not visible yet.
export const DEFAULT_RETRY_SECONDS = 30;
// Chosen, not measured: deliveries (claims) a row gets before it ends `failed` and the owner is told. With the base delay and the
// growth below the eight tries span 30+60+120+240+480+600+600 s, about 35 minutes: past a Temporal restart or a deploy, short of
// a day-long outage the owner should hear about.
export const DEFAULT_MAX_ATTEMPTS = 8;
// Chosen, not measured: the retry delay stops growing here (10 minutes), so a recovered Temporal is found again within one cap.
export const DEFAULT_RETRY_MAX_SECONDS = 600;
// Chosen: each failed attempt waits twice as long as the one before (classic exponential backoff), up to the cap above.
const BACKOFF_FACTOR = 2;
// Chosen: rows leased per round; one relay delivers them one by one in `seq` order.
export const DEFAULT_BATCH = 10;
// Chosen: the lease is extended three times per lease length, so one missed beat does not lose it.
const HEARTBEATS_PER_LEASE = 3;
// States with no way out in `taskTransitions` (contracts/states.ts); temporal.md: such a task never starts again.
const FINAL_TASK_STATES: ReadonlySet<string> = new Set(["ACCEPTED", "REJECTED", "CANCELLED", "FAILED"]);

export interface RelaySettings { readonly leaseSeconds: number; readonly retrySeconds: number; readonly maxAttempts: number; readonly retryMaxSeconds: number }

/** Seconds before the retry that follows the `attempts`-th failed delivery: base * 2^(attempts-1), never above the cap. */
export const retryDelaySeconds = (attempts: number, settings: Pick<RelaySettings, "retrySeconds" | "retryMaxSeconds">): number =>
	Math.min(settings.retryMaxSeconds, settings.retrySeconds * BACKOFF_FACTOR ** Math.max(0, attempts - 1));

const positiveInteger = (key: string, value: unknown, fallback: number): number => {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`setting ${key} must be a positive integer`);
	return value;
};

export const loadRelaySettings = async (settings: SettingsReader): Promise<RelaySettings> => {
	const snapshot = await settings.snapshot(RELAY_SETTING_KEYS);
	return {
		leaseSeconds: positiveInteger("relay.leaseSeconds", snapshot["relay.leaseSeconds"], DEFAULT_LEASE_SECONDS),
		retrySeconds: positiveInteger("relay.retrySeconds", snapshot["relay.retrySeconds"], DEFAULT_RETRY_SECONDS),
		maxAttempts: positiveInteger("relay.maxAttempts", snapshot["relay.maxAttempts"], DEFAULT_MAX_ATTEMPTS),
		retryMaxSeconds: positiveInteger("relay.retryMaxSeconds", snapshot["relay.retryMaxSeconds"], DEFAULT_RETRY_MAX_SECONDS),
	};
};

/** `stop_run` and `cleanup` are carried out by activities (StopExecution, CleanupWorkspace); the relay only calls them. */
export interface RelayEffects {
	readonly stopRun: (payload: Record<string, unknown>) => Promise<void>;
	readonly cleanup: (payload: Record<string, unknown>) => Promise<void>;
}

export interface RelayRepo {
	readonly outbox: OutboxRepository;
	readonly tasks: Pick<TaskRepository, "get">;
	readonly decisions: Pick<DecisionRepository, "get" | "updateDelivery">;
	/** The owner is told once per stuck row (`notifications_open_dedup`). */
	readonly notifications: Pick<ReturnType<typeof notificationRepo>, "create">;
	readonly settings: SettingsReader;
}

export interface RelayTimers {
	/** Calls `fn` every `ms` until the returned function is called. */
	readonly every: (ms: number, fn: () => void) => () => void;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const realTimers: RelayTimers = {
	every: (ms, fn) => { const handle = setInterval(fn, ms); return () => clearInterval(handle); },
	sleep: (ms, signal) => new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const handle = setTimeout(done, ms);
		function done() { clearTimeout(handle); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	}),
};

export interface RelayOptions {
	readonly repo: RelayRepo;
	readonly workflows: WorkflowClient;
	readonly effects?: RelayEffects;
	/** Names this relay in `lease_owner`; unique per relay process. */
	readonly owner: string;
	readonly timers?: RelayTimers;
	readonly clock?: () => Date;
	readonly batch?: number;
}

export type RowOutcome = "sent" | "done" | "failed" | "released" | "lost";
/** `confirmed`: `sent` rows the sweep of this round closed to `done` because PostgreSQL shows their effect. */
export interface PressResult { readonly claimed: number; readonly confirmed: number; readonly rows: readonly { readonly id: string; readonly kind: string; readonly outcome: RowOutcome }[] }

type Row = Awaited<ReturnType<OutboxRepository["claim"]>>[number];
// What a handler asks for; the relay then writes it only if the lease is still this relay's.
type Verdict = { readonly end: "sent" | "done" } | { readonly end: "failed"; readonly error: string };

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000);
const isNotFound = (error: unknown): boolean => (error as { name?: string } | null)?.name === "WorkflowNotFoundError";
// drizzle wraps a driver error in its own: the SQLSTATE sits on the error or on its cause.
const isUniqueViolation = (error: unknown): boolean => [error, (error as { cause?: unknown } | null)?.cause].some((e) => (e as { code?: string } | null)?.code === "23505");

export const createOutboxRelay = (options: RelayOptions) => {
	const { repo, workflows, effects, owner } = options;
	const timers = options.timers ?? realTimers;
	const clock = options.clock ?? (() => new Date());
	const batch = options.batch ?? DEFAULT_BATCH;

	// Writes the refusal of a decision whose task is closed, unless the workflow already resolved it: a row delivered again after
	// an Update that ended the workflow must keep its `applied` outcome.
	const refuseClosed = async (decisionId: string): Promise<void> => {
		const decision = await repo.decisions.get(decisionId);
		if (!decision || decision.deliveryState === "applied" || decision.deliveryState === "refused") return;
		await repo.decisions.updateDelivery(decisionId, { deliveryState: "refused", refusalReason: "task_closed", resolvedAt: clock() });
	};

	const startWorkflow = async (row: Row): Promise<Verdict> => {
		const task = row.taskId ? await repo.tasks.get(row.taskId, { includeDeleted: true }) : undefined;
		if (!task) return { end: "failed", error: "task_missing" };
		// PostgreSQL decides: a final task, or one whose workflow already ran, is never started again (temporal.md:21-22).
		if (FINAL_TASK_STATES.has(task.status ?? "") || task.status !== "CREATED" || task.workflowRunId) return { end: "done" };
		await workflows.startTask(task.id);
		return { end: "sent" };
	};

	const deliverDecision = async (row: Row): Promise<Verdict> => {
		if (!row.decisionId || !row.taskId) return { end: "failed", error: "deliver_decision row without decision or task" };
		const decision = await repo.decisions.get(row.decisionId);
		if (!decision) return { end: "failed", error: "decision_missing" };
		if (decision.kind === "physical_decision") return { end: "failed", error: "physical_decision is never an Update" };
		const task = await repo.tasks.get(row.taskId, { includeDeleted: true });
		if (!task) return { end: "failed", error: "task_missing" };
		if (FINAL_TASK_STATES.has(task.status ?? "")) {
			await refuseClosed(decision.id);
			return { end: "done" };
		}
		if (decision.deliveryState === "recorded") await repo.decisions.updateDelivery(decision.id, { deliveryState: "delivering", deliveredAt: clock() });
		await workflows.sendDecision(task.id, decision.kind!, decision.id);
		return { end: "sent" };
	};

	const wake = async (row: Row): Promise<Verdict> => {
		if (!row.taskId) return { end: "failed", error: "wake row without task" };
		try {
			await workflows.wake(row.taskId);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			// No workflow to wake (not started or already closed): the wake-up is true in PostgreSQL and needs no delivery.
			return { end: "done" };
		}
		// A Signal has no state PostgreSQL could confirm: once sent it is final (database.md: `done` = effect delivered).
		return { end: "done" };
	};

	const effect = (name: keyof RelayEffects) => async (row: Row): Promise<Verdict> => {
		const handler = effects?.[name];
		if (!handler) throw new Error(`no ${name} handler configured`);
		await handler({ ...((row.payload as Record<string, unknown> | null) ?? {}), taskId: row.taskId });
		return { end: "done" }; // the activity returned: nothing is left to confirm
	};

	const route = async (row: Row): Promise<Verdict> => {
		switch (row.kind) {
			case "start_workflow": return startWorkflow(row);
			case "deliver_decision": return deliverDecision(row);
			case "wake": return wake(row);
			case "stop_run": return effect("stopRun")(row);
			case "cleanup": return effect("cleanup")(row);
			case "notify": return { end: "done" }; // decided: the notifier reads notifications itself; the outbox row is only closed.
			default: return { end: "failed", error: `unknown kind ${String(row.kind)}` };
		}
	};

	// temporal.md "Retry limit": a row that cannot be delivered ends `failed`, and the owner is told once (dedup key per row). The
	// notification comes first: a crash between the two leaves the row `pending`, its next try ends here again, and the second
	// insert is the unique violation of `notifications_open_dedup`, which only means "already raised".
	const raise = async (row: Row): Promise<void> => {
		const at = clock();
		try {
			await repo.notifications.create({ id: randomUUID(), taskId: row.taskId, eventType: "retry_limit_exceeded", state: "open", dedupKey: `outbox-failed:${row.id}`, occurrences: 1, firstRaisedAt: at, lastRaisedAt: at });
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
		}
	};

	const fail = async (row: Row, error: string, settings: RelaySettings): Promise<RowOutcome> => {
		try {
			await raise(row);
		} catch (notifyError) {
			// The owner could not be told: keep the row pending so the next try ends here again, rather than failing it unseen.
			return (await repo.outbox.release(row.id!, owner, errorText(notifyError), retryDelaySeconds(row.attempts ?? 1, settings))) ? "released" : "lost";
		}
		return (await repo.outbox.markFailed(row.id!, owner, error)) ? "failed" : "lost";
	};

	const press = async (row: Row, settings: RelaySettings): Promise<RowOutcome> => {
		// Heartbeat: a delivery longer than one lease keeps the row, so no other relay takes it over while it is alive.
		const stop = timers.every(Math.max(1, Math.floor((settings.leaseSeconds * 1000) / HEARTBEATS_PER_LEASE)), () => { void repo.outbox.extend(row.id!, owner, settings.leaseSeconds).catch(() => undefined); });
		let verdict: Verdict;
		try {
			verdict = await route(row);
		} catch (error) {
			stop();
			const attempts = row.attempts ?? 1;
			// `attempts` counts claims, so this was attempt number `attempts`: the last one ends the row.
			if (attempts >= settings.maxAttempts) return fail(row, errorText(error), settings);
			return (await repo.outbox.release(row.id!, owner, errorText(error), retryDelaySeconds(attempts, settings))) ? "released" : "lost";
		}
		stop();
		if (verdict.end === "failed") return fail(row, verdict.error, settings);
		const written = verdict.end === "sent" ? await repo.outbox.markSent(row.id!, owner) : await repo.outbox.markDone(row.id!, owner);
		return written ? verdict.end : "lost";
	};

	// temporal.md "Sent and done": is the effect of a `sent` row visible in PostgreSQL? Both answers read only PostgreSQL.
	const effectVisible = async (row: Awaited<ReturnType<OutboxRepository["listSent"]>>[number]): Promise<boolean> => {
		if (row.kind === "start_workflow") {
			const task = row.taskId ? await repo.tasks.get(row.taskId, { includeDeleted: true }) : undefined;
			return !task || task.status !== "CREATED" || Boolean(task.workflowRunId);
		}
		if (row.kind === "deliver_decision") {
			const decision = row.decisionId ? await repo.decisions.get(row.decisionId) : undefined;
			return !decision || decision.deliveryState === "applied" || decision.deliveryState === "refused";
		}
		return true; // no other kind ends `sent`; a stray one has nothing to wait for
	};

	/** Closes the due `sent` rows whose effect is visible; the others are looked at again after the retry delay, never delivered again. */
	const sweepSent = async (settings: RelaySettings): Promise<number> => {
		let closed = 0;
		for (const row of await repo.outbox.listSent(batch)) {
			if (await effectVisible(row)) { if (await repo.outbox.closeSent(row.id!)) closed += 1; }
			else await repo.outbox.recheckSent(row.id!, settings.retrySeconds);
		}
		return closed;
	};

	/** One round: lease up to `batch` due rows and deliver them in `seq` order, then sweep the `sent` rows. */
	const pressOnce = async (): Promise<PressResult> => {
		const settings = await loadRelaySettings(repo.settings);
		const rows = await repo.outbox.claim({ owner, leaseSeconds: settings.leaseSeconds, limit: batch });
		const results: { id: string; kind: string; outcome: RowOutcome }[] = [];
		for (const row of rows) results.push({ id: row.id!, kind: row.kind!, outcome: await press(row, settings) });
		return { claimed: rows.length, confirmed: await sweepSent(settings), rows: results };
	};

	/** Rounds until `signal` aborts; waits `idleMs` when a round found nothing. */
	const run = async (signal: AbortSignal, idleMs = 1000): Promise<void> => {
		while (!signal.aborted) {
			let claimed = 0;
			try { claimed = (await pressOnce()).claimed; } catch { /* the database is unreachable: wait and try again */ }
			if (claimed === 0) await timers.sleep(idleMs, signal);
		}
	};

	return { pressOnce, run };
};

export type OutboxRelay = ReturnType<typeof createOutboxRelay>;
