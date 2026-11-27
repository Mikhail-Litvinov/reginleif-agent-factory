import { randomUUID } from 'node:crypto';
import type { Repo } from '../db/repo/index.ts';
import type { Right } from './check.ts';

type Store = Pick<Repo, 'registry' | 'roles' | 'roleAssignments' | 'taskReads' | 'rightsSuspensions' | 'agents'>;

export async function roleForParticipant(tx: Pick<Store, 'registry' | 'roles' | 'roleAssignments'>, taskId: string, participant: string) {
  await tx.registry.lock('read');
  const active = await tx.registry.regulations.active();
  const assignment = (await tx.roleAssignments.listForTask(taskId)).find(row => row.participant === participant);
  const role = assignment?.roleId ? await tx.roles.get(assignment.roleId) : undefined;
  return role?.status === 'active' && active && role.regulationVersionId === active.id ? role : undefined;
}

// The caller must execute this in a transaction, alongside the engineer's checked answer.
export async function assignRole(tx: Store, input: { taskId: string; participant: string; roleId: string; engineerRunId: string; participantRunId: string }) {
  const engineer = await tx.taskReads.getRun(input.engineerRunId);
  if (!engineer || engineer.role !== 'chief_engineer' || engineer.taskId !== input.taskId || engineer.id === input.participantRunId || engineer.participant === input.participant || !engineer.agentId) throw new Error('invalid chief engineer');
  await tx.agents.lock(engineer.agentId);
  if (await tx.rightsSuspensions.openForAgent(engineer.agentId)) throw new Error('invalid chief engineer');
  await tx.registry.lock('read');
  const role = await tx.roles.get(input.roleId);
  const active = await tx.registry.regulations.active();
  if (!role || role.status !== 'active' || !active || role.regulationVersionId !== active.id) throw new Error('role is not active');
  const previous = (await tx.roleAssignments.listForTask(input.taskId)).find(row => row.participant === input.participant);
  if (previous && !await tx.roleAssignments.supersede(previous.id)) throw new Error('role assignment changed');
  return tx.roleAssignments.create({ id: randomUUID(), taskId: input.taskId, participant: input.participant, roleId: input.roleId, assignedBy: { type: 'chief_engineer', id: input.engineerRunId } });
}

// Expressibility is determined by the sandbox adapter, not inferred from free text.
export function profileRights(roles: readonly Right[], grants: readonly { id: string; right: Right }[], expressible: (right: Right) => boolean): (Right & { source: string })[] {
  const eligible = (right: Right) => {
    const conditions = right.conditions;
    if (conditions && typeof conditions === 'object' && !Array.isArray(conditions) && (Reflect.get(conditions, 'once') === true || Reflect.get(conditions, 'reuse') === 'once')) return false;
    return expressible(right);
  };
  return [...roles.filter(eligible).map(right => ({ ...right, source: 'role' })), ...grants.filter(grant => eligible(grant.right)).map(grant => ({ ...grant.right, source: grant.id }))];
}
