/*
 * Response shapes api.md does not define field by field and handler packages must derive later:
 * - GET /tasks and GET /tasks/{id} envelopes and nested task/revision/dependency objects.
 * - GET /tasks/{id}/revisions, /runs, /events, /artifacts, /reviews and /decisions list envelopes and row fields.
 * - POST /tasks response row shape, artifact upload URL response, and the complete GET /decisions/{id} object.
 * - Response envelopes for the remaining project, agent, worker, registry, rights, personnel, robotics and client routes.
 */
import { z } from 'zod';
import {
  blockKinds,
  decisionChannels,
  decisionKinds,
  deliveryStates,
  executorReportStatuses,
  proposalKinds,
  taskStates,
} from '../states.ts';

const uuid = z.string().uuid();
const nonEmptyText = z.string().min(1);
const jsonValue = z.json();
const acceptanceCriteria = z.array(z.strictObject({ id: nonEmptyText }).catchall(jsonValue));

export const taskStateSchema = z.enum(taskStates);
export const blockKindSchema = z.enum(blockKinds);
export const decisionKindSchema = z.enum(decisionKinds);
export const decisionChannelSchema = z.enum(decisionChannels);
export const deliveryStateSchema = z.enum(deliveryStates);
export const executorReportStatusSchema = z.enum(executorReportStatuses);
export const proposalKindSchema = z.enum(proposalKinds);

export const createTaskRequestSchema = z.strictObject({
  project_id: uuid,
  title: nonEmptyText,
  description: z.string(),
  priority: z.number().int(),
  requirements: z.string(),
  acceptance_criteria: acceptanceCriteria,
  constraints: jsonValue,
  depends_on: z.array(uuid),
});

export const taskRevisionRequestSchema = z.strictObject({
  requirements: z.string(),
  acceptance_criteria: acceptanceCriteria,
  constraints: jsonValue,
  change_reason: nonEmptyText,
  revision_number: z.number().int().positive(),
});

const revisionNumber = z.number().int().positive();
const decisionPayloadSchemas = {
  approve: z.strictObject({ revision_number: revisionNumber, comment: z.string() }),
  reject: z.strictObject({ revision_number: revisionNumber, reason: nonEmptyText }),
  request_changes: z.strictObject({ revision_number: revisionNumber, findings: z.array(jsonValue), comment: z.string() }),
  cancel: z.strictObject({ reason: nonEmptyText }),
  pause: z.strictObject({ reason: nonEmptyText }),
  resume: z.strictObject({ reason: nonEmptyText }),
  add_feedback: z.strictObject({ text: nonEmptyText }),
  change_priority: z.strictObject({ priority: z.number().int() }),
  revise_requirements: taskRevisionRequestSchema,
  resolve_block: z.union([
    z.strictObject({ block_kind: blockKindSchema, answer: jsonValue, revision_number: revisionNumber }),
    z.strictObject({ block_kind: blockKindSchema, resume_to: taskStateSchema, revision_number: revisionNumber }),
    z.strictObject({ block_kind: blockKindSchema, choice: z.literal('call_owner'), reason: nonEmptyText }),
  ]),
  force_close: z.strictObject({ reason: nonEmptyText }),
  allow_agent: z.strictObject({ agent_id: uuid }),
} as const;

export const decisionRequestSchemas = decisionPayloadSchemas;

export const physicalDecisionRequestSchema = z.strictObject({
  platform: nonEmptyText,
  decision: jsonValue,
});

export const taskDecisionResponseSchema = z.strictObject({
  id: uuid,
  kind: decisionKindSchema,
  delivery_state: deliveryStateSchema,
  refusal_reason: z.string().nullable().optional(),
});

export const problemDetailsSchema = z.strictObject({
  type: z.string(),
  title: nonEmptyText,
  status: z.number().int().min(400).max(599),
  code: nonEmptyText,
  detail: z.string(),
  request_id: uuid,
  errors: z.array(z.strictObject({ pointer: z.string(), code: nonEmptyText, message: nonEmptyText })),
  retry_after: z.number().nonnegative().optional(),
  current_row_version: z.number().int().positive().optional(),
});

export const executorReportSchema = z.strictObject({
  actions: z.array(z.string()),
  changedFiles: z.array(z.string()),
  commits: z.array(z.strictObject({ hash: nonEmptyText, subject: nonEmptyText })),
  testResults: z.array(z.strictObject({
    id: nonEmptyText,
    command: nonEmptyText,
    exitCode: z.number().int().nullable(),
    status: z.enum(['passed', 'failed', 'not_run']),
    log: nonEmptyText,
  })),
  artifacts: z.array(z.union([
    z.strictObject({ kind: nonEmptyText, path: nonEmptyText, hash: nonEmptyText }),
    z.strictObject({ kind: nonEmptyText, url: z.url(), hash: nonEmptyText }),
  ])),
  problems: z.array(z.string()),
  uncheckedScenarios: z.array(z.string()),
  requirementDeviations: z.array(z.string()),
  finalStatus: executorReportStatusSchema,
});

export const artifactUploadRequestSchema = z.strictObject({
  artifact_type: nonEmptyText,
  size: z.number().int().nonnegative(),
  checksum: nonEmptyText,
  client_upload_id: uuid,
  metadata: jsonValue,
});

export const childTaskProposalRequestSchema = z.strictObject({
  title: nonEmptyText,
  requirements: z.string(),
  kind: proposalKindSchema,
});

export const contractSchemas = {
  createTaskRequestSchema,
  taskRevisionRequestSchema,
  ...Object.fromEntries(Object.entries(decisionPayloadSchemas).map(([kind, schema]) => [`${kind}DecisionRequestSchema`, schema])),
  physicalDecisionRequestSchema,
  taskDecisionResponseSchema,
  problemDetailsSchema,
  executorReportSchema,
  artifactUploadRequestSchema,
  childTaskProposalRequestSchema,
} as const;

export function toContractJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema);
}

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskRevisionRequest = z.infer<typeof taskRevisionRequestSchema>;
export type ExecutorReport = z.infer<typeof executorReportSchema>;
