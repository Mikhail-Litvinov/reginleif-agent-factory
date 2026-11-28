// The operation matrix and the state graph of TaskWorkflow, without Temporal (package 54): every state has a way out, every
// cell of the table is applicable, and the in-memory refusal checks follow temporal.md "Order of checks".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FORWARD_EXITS, MATRIX, applyCell, memoryRefusal, resolveCell } from "../workflows/task-matrix.ts";
import { FINAL_STATUSES, TASK_STATUSES, UPDATE_KINDS, initialState, isFinal, type TaskState, type TaskStatus } from "../workflows/task-state.ts";

/** A representative state of each status, with the fields its operations read (a block, a pause origin, a stop in progress). */
const sample = (status: TaskStatus, more: Partial<TaskState> = {}): TaskState => {
	const base: TaskState = { ...initialState("t1"), status, ...more };
	switch (status) {
		case "BLOCKED": return { ...base, blockKind: "scope", blockHandler: "owner", blockReason: "scope unclear", ...more };
		case "PAUSED": return { ...base, resumeTo: "ASSIGNED", ...more };
		case "CANCELLING": return { ...base, stopping: true, afterStop: "CANCELLED", executionId: "e1", ...more };
		default: return base;
	}
};

/** Every status an operation (not the run's own progress) can lead to from `state`. */
const operationExits = (state: TaskState): TaskStatus[] => {
	const out = new Set<TaskStatus>();
	for (const kind of UPDATE_KINDS) {
		const cell = resolveCell(state, kind);
		if (cell === "R" || cell === "X") continue;
		out.add(applyCell(state, kind, cell, { priority: 1, agent_id: "a" }).state.status);
	}
	return [...out];
};

describe("operation matrix", () => {
	it("has a row for every status and a cell for every kind", () => {
		assert.deepEqual(Object.keys(MATRIX).sort(), [...TASK_STATUSES].sort());
		for (const status of TASK_STATUSES) assert.deepEqual(Object.keys(MATRIX[status]).sort(), [...UPDATE_KINDS].sort(), status);
	});

	it("a final status refuses every kind with task_closed's cell (X), nothing in it applies", () => {
		for (const status of FINAL_STATUSES) for (const kind of UPDATE_KINDS) assert.equal(MATRIX[status][kind], "X", `${status}/${kind}`);
	});

	it("every applicable cell of every status applies, with and without a live execution, and keeps the state consistent", () => {
		for (const status of TASK_STATUSES) {
			for (const live of [false, true]) {
				const state = sample(status, live ? { executionId: "e1" } : {});
				for (const kind of UPDATE_KINDS) {
					const cell = resolveCell(state, kind);
					if (cell === "R" || cell === "X") continue;
					const { state: next } = applyCell(state, kind, cell, { priority: 2, agent_id: "a" });
					assert.ok(TASK_STATUSES.includes(next.status), `${status}/${kind}/${live}: status ${next.status}`);
					if (isFinal(next.status)) assert.deepEqual([next.pauseRequested, next.stopping, next.afterStop], [false, false, null], `${status}/${kind}: a final state keeps no pending stop`);
					// A block is held in BLOCKED, or in PAUSED that will resume into BLOCKED (task-matrix.ts `holdsBlock`); nowhere else.
					const holds = next.status === "BLOCKED" || (next.status === "PAUSED" && next.resumeTo === "BLOCKED");
					if (!holds) assert.equal(next.blockKind, null, `${status}/${kind}: a block does not outlive BLOCKED`);
				}
			}
		}
	});

	it("every non-final state reaches a final state through the run's forward exits and the operations", () => {
		for (const start of TASK_STATUSES.filter((status) => !isFinal(status))) {
			const seen = new Set<TaskStatus>([start]);
			const queue: TaskStatus[] = [start];
			while (queue.length > 0) {
				const status = queue.shift() as TaskStatus;
				for (const live of [false, true]) {
					for (const to of [...FORWARD_EXITS[status], ...operationExits(sample(status, live ? { executionId: "e1" } : {}))]) {
						if (!seen.has(to)) { seen.add(to); queue.push(to); }
					}
				}
			}
			assert.ok([...seen].some(isFinal), `${start} reaches no final state`);
		}
	});

	it("the states that wait for a person (AWAITING_APPROVAL, BLOCKED for the owner, PAUSED) are left by an owner operation alone", () => {
		for (const status of ["AWAITING_APPROVAL", "BLOCKED", "PAUSED"] as const) {
			const exits = operationExits(sample(status)).filter((to) => to !== status);
			assert.ok(exits.length > 0, `${status} has no operation that leaves it`);
		}
		assert.deepEqual(FORWARD_EXITS.AWAITING_APPROVAL, []);
		assert.deepEqual(FORWARD_EXITS.BLOCKED, []);
		assert.deepEqual(FORWARD_EXITS.PAUSED, []);
	});

	it("an owner can reach a final state from every state whose own progress needs the run (cancel, or force_close once cancelling)", () => {
		for (const status of ["CREATED", "READY", "WAITING_DEPENDENCIES", "PLANNING", "ASSIGNED", "RUNNING", "VERIFYING", "AWAITING_APPROVAL", "REWORK_REQUIRED", "BLOCKED", "PAUSED"] as const) {
			assert.notEqual(MATRIX[status].cancel, "R", `${status}: cancel`);
		}
		assert.notEqual(MATRIX.CANCELLING.force_close, "R");
	});
});

describe("memoryRefusal (order of checks)", () => {
	const blocked = (blockKind: TaskState["blockKind"], blockHandler: TaskState["blockHandler"]): TaskState => sample("BLOCKED", { blockKind, blockHandler });

	it("a system actor (null) may only resolve a block, and only one the chief engineer handles", () => {
		assert.equal(memoryRefusal(sample("ASSIGNED"), "pause", { actorId: null, payload: {}, revisionNumber: null }), "actor_not_allowed");
		assert.equal(memoryRefusal(blocked("scope", "owner"), "resolve_block", { actorId: null, payload: {}, revisionNumber: 1 }), "block_handled");
		assert.equal(memoryRefusal(blocked("dependency", "chief_engineer"), "resolve_block", { actorId: null, payload: {}, revisionNumber: 1 }), null);
	});

	it("the actor stage comes before the matrix, the matrix before the block kind, the block kind before the revision", () => {
		assert.equal(memoryRefusal(sample("CREATED"), "approve", { actorId: null, payload: {}, revisionNumber: 9 }), "actor_not_allowed");
		assert.equal(memoryRefusal(sample("CREATED"), "approve", { actorId: "o", payload: {}, revisionNumber: 9 }), "not_allowed_in_state");
		assert.equal(memoryRefusal(blocked("dependency", "chief_engineer"), "resolve_block", { actorId: "o", payload: { block_kind: "scope" }, revisionNumber: 9 }), "block_kind_mismatch");
		assert.equal(memoryRefusal(blocked("dependency", "chief_engineer"), "resolve_block", { actorId: "o", payload: { block_kind: "dependency" }, revisionNumber: 9 }), "revision_stale");
	});

	it("a block kind that is not a kind at all is a mismatch, one that matches is not", () => {
		const state = blocked("dependency", "chief_engineer");
		assert.equal(memoryRefusal(state, "resolve_block", { actorId: "o", payload: { block_kind: "nonsense" }, revisionNumber: 1 }), "block_kind_mismatch");
		assert.equal(memoryRefusal(state, "resolve_block", { actorId: "o", payload: { block_kind: "dependency" }, revisionNumber: 1 }), null);
		assert.equal(memoryRefusal(state, "resolve_block", { actorId: "o", payload: {}, revisionNumber: 1 }), null);
	});

	it("only the revision kinds check the revision", () => {
		const state = { ...sample("AWAITING_APPROVAL"), revision: 4 };
		for (const kind of ["approve", "reject", "request_changes"] as const) {
			assert.equal(memoryRefusal(state, kind, { actorId: "o", payload: {}, revisionNumber: 3 }), "revision_stale", kind);
			assert.equal(memoryRefusal(state, kind, { actorId: "o", payload: {}, revisionNumber: 4 }), null, kind);
		}
		assert.equal(memoryRefusal(state, "cancel", { actorId: "o", payload: {}, revisionNumber: null }), null);
		assert.equal(memoryRefusal(state, "add_feedback", { actorId: "o", payload: {}, revisionNumber: 1 }), null);
	});

	it("an operation the task's status does not allow is not_allowed_in_state, also for a status the matrix marks closed", () => {
		for (const status of FINAL_STATUSES) assert.equal(memoryRefusal(sample(status), "pause", { actorId: "o", payload: {}, revisionNumber: 1 }), "not_allowed_in_state");
	});

	it("a payload the cell cannot apply is invalid_payload, checked last (after the state checks)", () => {
		const read = (payload: Record<string, unknown>) => ({ actorId: "o", payload, revisionNumber: null });
		for (const payload of [{}, { priority: "5" }, { priority: null }, { priority: Number.NaN }, { priority: Number.POSITIVE_INFINITY }]) {
			assert.equal(memoryRefusal(sample("ASSIGNED"), "change_priority", read(payload)), "invalid_payload", JSON.stringify(payload));
			assert.equal(memoryRefusal(sample("RUNNING", { executionId: "e1" }), "change_priority", read(payload)), "invalid_payload", JSON.stringify(payload));
		}
		for (const priority of [0, 5, -1, 2.5]) assert.equal(memoryRefusal(sample("ASSIGNED"), "change_priority", read({ priority })), null, String(priority));
		for (const payload of [{}, { agent_id: "" }, { agent_id: 3 }, { agent_id: null }]) {
			assert.equal(memoryRefusal(sample("ASSIGNED"), "allow_agent", read(payload)), "invalid_payload", JSON.stringify(payload));
		}
		assert.equal(memoryRefusal(sample("ASSIGNED"), "allow_agent", read({ agent_id: "agent-7" })), null);
		assert.equal(memoryRefusal(sample("ACCEPTED"), "change_priority", read({})), "not_allowed_in_state");
	});

	it("pause/resume flags follow the state: resume without a pending pause is not allowed", () => {
		assert.equal(memoryRefusal(sample("RUNNING", { executionId: "e1" }), "resume", { actorId: "o", payload: {}, revisionNumber: null }), "not_allowed_in_state");
		assert.equal(memoryRefusal(sample("RUNNING", { executionId: "e1", pauseRequested: true }), "resume", { actorId: "o", payload: {}, revisionNumber: null }), null);
	});
});
