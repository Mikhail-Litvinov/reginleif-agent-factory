import { canonicalJson } from '../api/second-press.ts';
import { routes } from '../contracts/routes.ts';
import type { Repo } from '../db/repo/index.ts';

export type Right = { action: string; target: string; conditions: unknown };
type RecordRight = { id: string; number: string; right: unknown; once: boolean };
type GrantRight = { id: string; right: unknown };
export type CheckInput = {
  call: unknown; suspended: boolean; guard: boolean; deny: readonly unknown[]; roles: readonly unknown[];
  records: readonly RecordRight[]; grants: readonly GrantRight[]; consume: (id: string) => Promise<boolean>;
};
export type CheckAnswer = { allowed: boolean; source: 'role' | 'record' | 'grant' | 'refused' | 'none'; ref?: string; reason?: string };

function readable(value: unknown): value is Right {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof Reflect.get(value, 'action') === 'string' && typeof Reflect.get(value, 'target') === 'string' &&
    Object.hasOwn(value, 'conditions');
}
function matches(value: unknown, call: unknown): boolean {
  return readable(value) && readable(call) && canonicalJson(value) === canonicalJson(call);
}
export async function checkRights(input: CheckInput): Promise<CheckAnswer> {
  if (input.suspended) return { allowed: false, source: 'refused', reason: 'suspended' };
  if (input.guard || input.deny.some(right => matches(right, input.call))) return { allowed: false, source: 'refused', reason: 'denied' };
  if (input.roles.some(right => matches(right, input.call))) return { allowed: true, source: 'role' };
  for (const record of input.records) {
    if (matches(record.right, input.call) && (!record.once || await input.consume(record.id))) return { allowed: true, source: 'record', ref: record.number };
  }
  const grant = input.grants.find(item => matches(item.right, input.call));
  return grant ? { allowed: true, source: 'grant', ref: grant.id } : { allowed: false, source: 'none' };
}

type Store = Pick<Repo, 'agents' | 'policies' | 'registry' | 'rightsSuspensions' | 'roleAssignments' | 'roles' | 'rightGrants'>;
export type RightSubject = { projectId: string | null; taskId: string | null; participant: string | null; agentId: string | null; sessionRef: string | null };

// The caller supplies the subject from trusted run/session state, never from the requested right.
export async function checkForSubject(tx: Store, subject: RightSubject, call: Right | undefined, now: Date, guard = false): Promise<CheckAnswer> {
  let configuration: unknown;
  if (subject.agentId) {
    await tx.agents.lock(subject.agentId);
    if (await tx.rightsSuspensions.openForAgent(subject.agentId)) return { allowed: false, source: 'refused', reason: 'suspended' };
    configuration = (await tx.agents.get(subject.agentId))?.configuration;
  }
  if (guard) return { allowed: false, source: 'refused', reason: 'denied' };
  if (!call) return { allowed: false, source: 'none' };
  const policy = await tx.policies.effective(subject.projectId);
  const profile = configuration && typeof configuration === 'object' && !Array.isArray(configuration) ? configuration as Record<string, unknown> : {};
  const fields = call.conditions && typeof call.conditions === 'object' && !Array.isArray(call.conditions) ? call.conditions as Record<string, unknown> : {};
  const tool = typeof fields.tool === 'string' ? fields.tool : call.action === 'tool' ? call.target : /^(?:bash|shell|exec|powershell)$/i.test(call.action) ? call.action : undefined;
  const tools = profile.tools && typeof profile.tools === 'object' && !Array.isArray(profile.tools) ? profile.tools as Record<string, unknown> : {};
  const deniedTools = profile.denied_tools ?? tools.denied;
  const allowedTools = profile.allowed_tools ?? tools.allowed ?? (Array.isArray(profile.tools) ? profile.tools : undefined);
  if (tool && ((policy?.allowedTools && !policy.allowedTools.includes(tool)) ||
    (Array.isArray(deniedTools) && deniedTools.includes(tool)) || (Array.isArray(allowedTools) && !allowedTools.includes(tool)))) {
    return { allowed: false, source: 'refused', reason: 'denied' };
  }
  await tx.registry.lock('read');
  const assignments = subject.taskId && subject.participant ? await tx.roleAssignments.listForTask(subject.taskId) : [];
  const assignment = assignments.find(row => row.participant === subject.participant);
  const role = assignment?.roleId ? await tx.roles.get(assignment.roleId) : undefined;
  const usableRole = role?.status === 'active' ? role : undefined;
  const deny = Array.isArray(usableRole?.deny) ? usableRole.deny : [];
  const roles = Array.isArray(usableRole?.rights) ? usableRole.rights : [];
  const roleAnswer = await checkRights({ call, suspended: false, guard: false, deny, roles: [], records: [], grants: [], consume: async () => false });
  if (roleAnswer.source !== 'none') return roleAnswer;
  // security.md:53,62 and modules.md:167-176: repository, directory and Git guards run on the phase 4 worker.
  // Until a trusted worker result exists, calls needing those guards cannot be allowed here.
  const serverOperation = routes.some(route => route.secondPress && `${route.method} ${route.path}` === call.action);
  if (!serverOperation || tool || /[/\\]/u.test(call.target) || /^[a-z]:/i.test(call.target) || ['tool', 'path', 'real_path', 'repository', 'program', 'arguments', 'args', 'command'].some(key => Object.hasOwn(fields, key))) return { allowed: false, source: 'none' };
  if (roles.some(right => matches(right, call))) return { allowed: true, source: 'role' };
  const rows = await tx.registry.records.list({ kind: 'permission', status: 'active' });
  const conditions = call.conditions && typeof call.conditions === 'object' && !Array.isArray(call.conditions) ? call.conditions as Record<string, unknown> : {};
  const records = rows.filter(row => row.kind === 'permission' && row.status === 'active' &&
    (row.scopeType === 'global' || (row.scopeType === 'project' && row.projectId === subject.projectId && subject.projectId !== null)) &&
    (row.repository === null || row.repository === conditions.repository) && (row.machineId === null || row.machineId === conditions.machine_id) &&
    (row.action === null || row.action === call.action) && (row.target === null || row.target === call.target) &&
    (row.reuse === 'standing' || (row.reuse === 'once' && row.consumedAt === null)))
    .map(row => ({ id: row.id, number: String(row.number), right: row.right, once: row.reuse === 'once' }));
  const recordAnswer = await checkRights({ call, suspended: false, guard: false, deny: [], roles: [], records, grants: [], consume: async id => Boolean(await tx.registry.records.consumePermission(id, now)) });
  if (recordAnswer.source !== 'none') return recordAnswer;
  const grantRows = subject.taskId && subject.participant ? await tx.rightGrants.list({ taskId: subject.taskId, participant: subject.participant, state: 'live' }) :
    subject.sessionRef ? await tx.rightGrants.list({ sessionRef: subject.sessionRef, state: 'live' }) : [];
  const grants = grantRows.filter(row => row.endedAt === null && (subject.taskId ? row.taskId === subject.taskId && row.participant === subject.participant : row.taskId === null && row.sessionRef === subject.sessionRef)).map(row => ({ id: row.id, right: row.right }));
  return checkRights({ call, suspended: false, guard: false, deny: [], roles: [], records: [], grants, consume: async () => false });
}
