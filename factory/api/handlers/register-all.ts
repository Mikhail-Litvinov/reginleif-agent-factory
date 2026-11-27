import type { Repo } from '../../db/repo/index.ts';
import type { createApiServer } from '../server.ts';
import { registerClientHandlers } from './client.ts';
import { registerAdminHandlers } from './index.ts';
import { registerTasks } from './tasks.ts';
import { registerRelayHandlers } from '../../telegram/relay-role.ts';

type Options = {
  now?: () => Date;
  queueGatewayEnabled?: boolean;
  contractVersion?: number;
  client?: Parameters<typeof registerClientHandlers>[2];
};

// The single list of handler groups. Server startup calls this one function; a new group is added here and nowhere else.
export function registerAllHandlers(api: ReturnType<typeof createApiServer>, repo: Repo, options: Options = {}): void {
  const { now, queueGatewayEnabled, contractVersion, client } = options;
  registerAdminHandlers(api, { repo, now, queueGatewayEnabled });
  registerTasks(api, repo, { clock: now, contractVersion });
  registerClientHandlers(api, repo, client);
  registerRelayHandlers(api, repo);
}
