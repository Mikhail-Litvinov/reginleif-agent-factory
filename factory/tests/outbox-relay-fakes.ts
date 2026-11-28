// In-memory stand-ins for the outbox relay's collaborators (repo and WorkflowClient). The lease rules copy the SQL of
// outboxRepo: a row is taken only while `pending`, unleased and due; a mark or an extend works only for the lease owner.
import type { RelayRepo } from "../control/outbox-relay.ts";
import type { WorkflowClient } from "../control/workflow-client.ts";

export interface FakeRow {
	id: string; seq: bigint; kind: string; taskId: string | null; decisionId: string | null; payload: Record<string, unknown> | null;
	state: "pending" | "sent" | "done" | "failed"; attempts: number; nextAttemptAt: number | null; leaseOwner: string | null; lastError: string | null;
}
export interface FakeTask { id: string; status: string; workflowRunId: string | null }
export interface FakeDecision { id: string; taskId: string; kind: string; deliveryState: string; refusalReason: string | null; deliveredAt: Date | null; resolvedAt: Date | null }

export const fakeStore = (settings: Record<string, unknown> = {}) => {
	let now = 1_000_000;
	let seq = 0n;
	const rows = new Map<string, FakeRow>();
	const tasks = new Map<string, FakeTask>();
	const decisions = new Map<string, FakeDecision>();
	const extended: string[] = [];
	const hooks = { beforeMarkSent: undefined as undefined | (() => void) };

	const finish = (id: string, owner: string, patch: Partial<FakeRow>): boolean => {
		const row = rows.get(id);
		if (!row || row.leaseOwner !== owner || row.state !== "pending") return false;
		Object.assign(row, patch, { leaseOwner: null });
		return true;
	};

	const outbox = {
		claim: async ({ owner, limit }: { owner: string; leaseSeconds: number; limit: number }) => {
			const due = [...rows.values()].filter((row) => row.state === "pending" && row.leaseOwner === null && (row.nextAttemptAt === null || row.nextAttemptAt <= now))
				.sort((a, b) => (a.seq < b.seq ? -1 : 1)).slice(0, limit);
			for (const row of due) { row.leaseOwner = owner; row.attempts += 1; }
			return due.map((row) => ({ ...row }));
		},
		extend: async (id: string, owner: string) => { const ok = rows.get(id)?.leaseOwner === owner; if (ok) extended.push(id); return ok; },
		markSent: async (id: string, owner: string) => { hooks.beforeMarkSent?.(); return finish(id, owner, { state: "sent", lastError: null }); },
		markDone: async (id: string, owner: string) => finish(id, owner, { state: "done", lastError: null }),
		markFailed: async (id: string, owner: string, error: string) => finish(id, owner, { state: "failed", lastError: error }),
		release: async (id: string, owner: string, error: string, retryAfterSeconds: number) => finish(id, owner, { lastError: error, nextAttemptAt: now + retryAfterSeconds * 1000 }),
	};

	const repo = {
		outbox,
		tasks: { get: async (id: string) => tasks.get(id) },
		decisions: {
			get: async (id: string) => decisions.get(id),
			updateDelivery: async (id: string, patch: Partial<FakeDecision>) => { const row = decisions.get(id); if (row) Object.assign(row, patch); return row ?? null; },
		},
		settings: { snapshot: async (keys: readonly string[]) => Object.fromEntries(keys.filter((key) => key in settings).map((key) => [key, settings[key]])) },
	} as unknown as RelayRepo;

	return {
		repo, rows, tasks, decisions, extended, hooks,
		addTask: (id: string, status = "RUNNING", workflowRunId: string | null = null) => { tasks.set(id, { id, status, workflowRunId }); },
		addDecision: (id: string, taskId: string, kind = "approve", deliveryState = "recorded") => { decisions.set(id, { id, taskId, kind, deliveryState, refusalReason: null, deliveredAt: null, resolvedAt: null }); },
		addRow: (id: string, kind: string, fields: Partial<FakeRow> = {}) => {
			seq += 1n;
			rows.set(id, { id, seq, kind, taskId: null, decisionId: null, payload: null, state: "pending", attempts: 0, nextAttemptAt: null, leaseOwner: null, lastError: null, ...fields });
		},
		/** The lease of a relay that died runs out (the database clock moves past `lease_until`). */
		expireLease: (id: string) => { rows.get(id)!.leaseOwner = null; },
		advance: (ms: number) => { now += ms; },
	};
};

/** A WorkflowClient with Temporal's dedupe rules: one start per workflow id, one Update effect per update id. */
export const fakeTemporal = () => {
	const started = new Set<string>();
	const updates = new Map<string, { taskId: string; name: string }>();
	const log: string[] = [];
	const failures: Error[] = [];
	const client: WorkflowClient = {
		startTask: async (taskId) => {
			log.push(`start ${taskId}`);
			const fail = failures.shift(); if (fail) throw fail;
			const first = !started.has(taskId); started.add(taskId);
			return { workflowId: `task-${taskId}`, started: first };
		},
		sendDecision: async (taskId, name, decisionId) => {
			log.push(`update ${name} ${decisionId}`);
			const fail = failures.shift(); if (fail) throw fail;
			if (!updates.has(decisionId)) updates.set(decisionId, { taskId, name });
			return { ok: true };
		},
		wake: async (taskId) => {
			log.push(`wake ${taskId}`);
			const fail = failures.shift(); if (fail) throw fail;
		},
	};
	return { client, started, updates, log, failures };
};
