import type { Repo } from '../db/repo/index.ts';
import { randomUUID } from 'node:crypto';
import { canonicalJson, requestHash } from '../api/second-press.ts';
import { standingTaskFor } from './standing-task.ts';
import { checkForSubject, type CheckAnswer, type Right, type RightSubject } from './check.ts';

// governance.md, Rights: the enumerated routine publication and deletion targets.
const routineTargets: Record<string, readonly string[]> = {
  push: ['working_branch'],
  pull_request: ['open', 'update'],
  delete: ['temporary_files', 'clean_worktree', 'logs', 'closed_task_draft_artifacts'],
};
export function isOwnerOnly(right: Right): boolean {
  if (Object.hasOwn(routineTargets, right.action)) return !routineTargets[right.action]!.includes(right.target);
  return ['merge', 'release', 'publish', 'rewrite_history', 'change_safety_limits', 'change_hardware_circuits', 'purchase_outside_budget'].includes(right.action);
}

type Answer = { answer: string | null; reason?: string | null };
export function answerState(answers: readonly Answer[]): 'open' | 'call_owner' | 'granted' | 'refused' {
  const last = answers.at(-1)?.answer;
  return last === 'call_owner' ? 'call_owner' : last === 'grant' ? 'granted' : last === 'refuse' ? 'refused' : 'open';
}

export async function repeatRefusal(tx: Pick<Repo, 'rightRequests' | 'rightAnswers'>, taskId: string | null, requestHash: string): Promise<string | null | undefined> {
  if (!taskId) return undefined;
  for (const request of await tx.rightRequests.list({ taskId, requestHash })) {
    const answers = await tx.rightAnswers.listForRequest(request.id);
    const last = answers.at(-1);
    if (last?.answer === 'refuse') return last.reason;
  }
  return undefined;
}

type RequestStore = Pick<Repo, 'tasks' | 'rightRequests' | 'rightAnswers' | 'agents' | 'policies' | 'registry' | 'rightsSuspensions' | 'roleAssignments' | 'roles' | 'rightGrants'>;
export async function createRightRequest(tx: RequestStore, input: { subject: RightSubject; runId: string | null; right: Right; reason: string; tried: string; now?: Date }, check: () => Promise<CheckAnswer> = () => checkForSubject(tx, input.subject, input.right, input.now ?? new Date())) {
  const result = await check();
  if (result.allowed || result.source === 'refused') return { status: 200 as const, body: result };
  const hash = requestHash(canonicalJson({ ...input.right, answer: 'grant' }));
  const refusal = await repeatRefusal(tx, input.subject.taskId, hash);
  const handlingTaskId = input.subject.taskId ?? await standingTaskFor(tx.tasks, input.subject.projectId);
  const row = await tx.rightRequests.create({ id: randomUUID(), taskId: input.subject.taskId, sessionRef: input.subject.taskId ? null : input.subject.sessionRef, runId: input.runId, participant: input.subject.participant, action: input.right.action, target: input.right.target, conditions: input.right.conditions, reason: input.reason, tried: input.tried, requestHash: hash, handlingTaskId });
  let state: 'open' | 'call_owner' | 'refused' = 'open';
  if (isOwnerOnly(input.right) || refusal !== undefined) {
    state = isOwnerOnly(input.right) ? 'call_owner' : 'refused';
    await tx.rightAnswers.create({ id: randomUUID(), requestId: row.id, step: 1, stepKind: 'code', answer: state === 'refused' ? 'refuse' : 'call_owner', reason: state === 'refused' ? refusal : 'owner list', answeredBy: { type: 'code' } });
  }
  return { status: 202 as const, body: { id: row.id, state } };
}

export async function answerOwnerRequest(tx: Pick<Repo, 'rightRequests' | 'rightAnswers' | 'confirmations' | 'rightGrants'>, input: { requestId: string; ownerId: string; answer: 'refuse'; reason?: string } | { requestId: string; ownerId: string; answer: 'grant'; ownerActRef: string; channel: string; deviceSessionId: string | null; now: Date; reason?: string }) {
  const request = await tx.rightRequests.get(input.requestId);
  if (!request) return { error: 'not_found' as const };
  const answers = await tx.rightAnswers.listForRequest(request.id);
  const state = answerState(answers);
  if (state === 'granted' || state === 'refused') return { error: 'request_closed' as const };
  if (state !== 'call_owner') return { error: 'request_not_owner' as const };
  if (input.answer === 'grant') {
    const act = await tx.confirmations.get(input.ownerActRef);
    if (!act || act.actorId !== input.ownerId || act.channel !== input.channel || act.deviceSessionId !== input.deviceSessionId || act.targetType !== 'right_request' || act.targetId !== request.id || act.requestHash !== request.requestHash || act.operation !== 'right_request' || act.usedAt || !act.expiresAt || act.expiresAt <= input.now) return { error: 'confirmation_invalid' as const };
  }
  const answer = await tx.rightAnswers.create({ id: randomUUID(), requestId: request.id, step: answers.length + 1, stepKind: 'owner', answer: input.answer, ownerActRef: input.answer === 'grant' ? input.ownerActRef : null, reason: input.reason ?? null, answeredBy: { type: 'owner', id: input.ownerId } });
  if (input.answer === 'grant') {
    const grant = (await tx.rightGrants.list({ ...(request.taskId ? { taskId: request.taskId } : { sessionRef: request.sessionRef! }) })).find(row => row.answerId === answer.id);
    if (!grant) throw new Error('grant was not created');
    return { answer, grant };
  }
  return { answer };
}

// Grants need the additional regulation and width checks implemented with the engineer run in phase 4.
export async function recordEngineerAnswer(tx: Pick<Repo, 'rightRequests' | 'rightAnswers' | 'taskReads' | 'agents' | 'rightsSuspensions'>, input: { requestId: string; engineerRunId: string; answer: 'refuse' | 'call_owner'; reason: string }) {
  const request = await tx.rightRequests.get(input.requestId);
  const run = await tx.taskReads.getRun(input.engineerRunId);
  if (!request || !run || run.id === request.runId || run.role !== 'chief_engineer' || run.taskId !== request.handlingTaskId || !run.agentId) throw new Error('invalid chief engineer');
  await tx.agents.lock(run.agentId);
  if (await tx.rightsSuspensions.openForAgent(run.agentId)) throw new Error('invalid chief engineer');
  if ((await tx.rightAnswers.listForRequest(request.id)).length) throw new Error('request already answered');
  return tx.rightAnswers.create({ id: randomUUID(), requestId: request.id, step: 1, stepKind: 'chief_engineer', answer: input.answer, reason: input.reason, answeredBy: { type: 'run', id: run.id }, answerRunId: run.id });
}
