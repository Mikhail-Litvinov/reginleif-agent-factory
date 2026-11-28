import type { BlockKind } from "../../contracts/states.ts";
import { blockHandler, type BlockCause, type BlockHandler } from "../../rights/blocks.ts";

// temporal.md block rule: the handler is chosen on entering BLOCKED by rights/blocks.ts from facts the workflow supplies.
// The owner is told only about a block that entered as `owner`. A block whose engineer is unavailable waits and tells
// nobody (block-owner-load); an agent never chooses the handler.
export interface ChooseBlockHandlerInput {
	readonly kind: BlockKind;
	readonly cause?: BlockCause;
	// Whether the chief engineer can take the block now (its agent is enabled and has capacity); a fact from the workflow.
	readonly engineerAvailable: boolean;
	// For `scope`: true when the block was raised by an agent's question, which makes it go through the registry gate.
	readonly raisedByQuestion?: boolean;
}

export interface BlockHandlerDecision {
	readonly handler: BlockHandler;
	// True only for an `owner` block. This is the single place that decides whether the owner hears of the block.
	readonly notifyOwner: boolean;
	// True when the chief engineer has to take the block but cannot: it stays BLOCKED, nobody is told, and the workflow retries.
	readonly waiting: boolean;
	readonly viaGate: boolean;
}

/** agent_question, and scope raised by an agent's question, go through the registry gate first. Other kinds never do. */
export const goesThroughQuestionGate = (kind: BlockKind, raisedByQuestion = false): boolean =>
	kind === "agent_question" || (kind === "scope" && raisedByQuestion);

export const ChooseBlockHandler = (input: ChooseBlockHandlerInput): BlockHandlerDecision => {
	const handler = blockHandler(input.kind, input.cause);
	return {
		handler,
		notifyOwner: handler === "owner",
		waiting: handler === "chief_engineer" && !input.engineerAvailable,
		viaGate: goesThroughQuestionGate(input.kind, input.raisedByQuestion),
	};
};
