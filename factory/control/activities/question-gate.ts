import { createHash } from "node:crypto";
import type { BlockKind } from "../../contracts/states.ts";
import type { Repo } from "../../db/repo/index.ts";
import { createRegistryGate } from "../../registry/gate.ts";
import type { createRegistrySearch } from "../../registry/search.ts";
import type { PersistTaskEventInput } from "../index.ts";
import { goesThroughQuestionGate } from "./block-handler.ts";

type Search = ReturnType<typeof createRegistrySearch>;
type Timer = { set: (callback: () => void, milliseconds: number) => unknown; clear: (handle: any) => void };

export interface QuestionGateDeps {
	readonly repo: Pick<Repo, "registry" | "settings">;
	readonly search: Search;
	// Writes the local fail-open record (a task event). It is local, so an unavailable registry cannot prevent fail-open.
	readonly persistEvent: (event: PersistTaskEventInput) => Promise<unknown>;
	// Tests inject a timer so the gate timeout never waits on the wall clock.
	readonly timer?: Timer;
}

export interface QuestionGateInput {
	readonly taskId: string;
	readonly runId: string | null;
	readonly kind: BlockKind;
	readonly raisedByQuestion?: boolean;
	// The agent's session identity: the inquiry must belong to it.
	readonly actor: { readonly tokenId: string; readonly sessionRef?: string | null; readonly runId?: string | null };
	readonly inquiryId: string;
	// The real question text: the server searches by it again, whatever the agent searched before.
	readonly question: string;
}

export type QuestionGateResult =
	| { readonly gated: false }
	| { readonly gated: true; readonly pass: true; readonly failedOpen: boolean }
	| { readonly gated: true; readonly pass: false; readonly records: readonly unknown[] };

// A deterministic UUID, so a repeated activity attempt writes the same event row.
const eventId = (key: string): string => {
	const hex = createHash("sha256").update(key).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Registry-first gate of governance G9 for agent_question and for scope blocks raised by an agent's question.
 * The registry is asked before the question reaches the chief engineer or the owner. After registry.gateTimeoutMs, or when
 * the search is down, the question passes (registry-fail-open) and the fail-open is recorded as a task event.
 * The gate attaches newly found records to the inquiry (registry_inquiry_results insert). Migration 0006 granted that to
 * af_api; migration 0010 grants it to af_control too, limited by a trigger to found_by 'gate' without a verdict, so the
 * gate runs on the Control Worker's af_control repo.
 */
export const createQuestionGate = (deps: QuestionGateDeps) => async (input: QuestionGateInput): Promise<QuestionGateResult> => {
	if (!goesThroughQuestionGate(input.kind, input.raisedByQuestion)) return { gated: false };
	const settings = await deps.repo.settings.snapshot(["registry.gateTimeoutMs"]);
	const timeoutMs = settings["registry.gateTimeoutMs"];
	if (typeof timeoutMs !== "number") throw new RangeError("registry.gateTimeoutMs must be a number");
	const failOpens: { inquiryId: string; reason: "timeout" | "unavailable" }[] = [];
	const gate = createRegistryGate(deps.repo, deps.search, {
		timeoutMs,
		...(deps.timer ? { timer: deps.timer } : {}),
		recordFailOpen: event => { failOpens.push(event); },
	});
	const answer = await gate(input.actor, { inquiryId: input.inquiryId, question: input.question });
	for (const event of failOpens) {
		const dedupeKey = `registry-fail-open:${event.inquiryId}:${event.reason}`;
		await deps.persistEvent({
			id: eventId(`${input.taskId}|${dedupeKey}`), taskId: input.taskId, runId: input.runId, eventType: "registry_fail_open",
			actorType: "workflow", actorId: null, payload: { inquiryId: event.inquiryId, reason: event.reason, timeoutMs },
			correlationId: null, dedupeKey,
		});
	}
	return answer.pass ? { gated: true, pass: true, failedOpen: failOpens.length > 0 } : { gated: true, pass: false, records: answer.records };
};
