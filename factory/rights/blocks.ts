import type { BlockKind } from '../contracts/states.ts';

export type BlockHandler = 'owner' | 'chief_engineer';
export type BlockCause = { needsOwner?: boolean; noEnabledAgentCanRun?: boolean };

/** The workflow supplies facts about the cause; an agent never chooses the handler. */
export function blockHandler(kind: BlockKind, cause: BlockCause = {}): BlockHandler {
  if (kind === 'usage_limit') return cause.noEnabledAgentCanRun ? 'owner' : 'chief_engineer';
  if (kind === 'scope' || kind === 'agent_question' || kind === 'quarantine' || cause.needsOwner) return 'owner';
  return 'chief_engineer';
}

