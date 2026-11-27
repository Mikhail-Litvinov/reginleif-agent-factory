import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { registerAgentHandlers } from './agents.ts';
import { registerAuditHandlers } from './audit.ts';
import { registerCleanupHandlers } from './cleanup.ts';
import { registerEventHandlers } from './events.ts';
import { registerPolicyHandlers } from './policies.ts';
import { registerTokenHandlers } from './tokens.ts';
import { registerWorkerHandlers } from './workers.ts';

export function registerAdminHandlers(api: HandlerRegistrar, dependencies: HandlerDeps): void {
  registerEventHandlers(api, dependencies);
  registerTokenHandlers(api, dependencies);
  registerCleanupHandlers(api, dependencies);
  registerAgentHandlers(api, dependencies);
  registerWorkerHandlers(api, dependencies);
  registerPolicyHandlers(api, dependencies);
  registerAuditHandlers(api, dependencies);
}
