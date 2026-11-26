import { z } from 'zod';

const uuid = z.string().uuid();
const time = z.iso.datetime();
const integer = z.number().int();
const nullableLimit = integer.nullable();

export const policyPutSchema = z.strictObject({
  allowed_commands: z.array(z.string()), allowed_directories: z.array(z.string()),
  allowed_repositories: z.array(z.string()), network: z.json(), git_operations: z.array(z.string()),
  confirmation_required: z.array(z.string()), allowed_tools: z.array(z.string()),
  max_concurrent_tasks: nullableLimit, max_tasks_per_agent: nullableLimit, max_run_seconds: nullableLimit,
  max_tokens: nullableLimit, max_cost: z.string().nullable(), currency: z.string().nullable(),
  max_auto_fixes: nullableLimit, max_attempts: nullableLimit, max_rework_rounds: nullableLimit,
  max_child_depth: nullableLimit, max_children_per_task: nullableLimit, auto_accept_low_risk: z.boolean(),
});

export const executionPolicySchema = policyPutSchema.extend({
  id: uuid, project_id: uuid.nullable(), version: integer, created_by: uuid, created_at: time,
});

export const projectCreateSchema = z.strictObject({
  name: z.string(), description: z.string().optional(), repository_url: z.string(),
  default_branch: z.string().optional(), workspace_policy: z.literal('worktree').optional(),
  settings: z.json().optional(), priority: integer.optional(),
});
export const projectPatchSchema = projectCreateSchema.partial();
export const projectSchema = z.strictObject({
  id: uuid, name: z.string(), description: z.string(), repository_url: z.string(), default_branch: z.string(),
  workspace_policy: z.literal('worktree'), settings: z.json(), priority: integer, created_at: time,
  updated_at: time, archived_at: time.nullable(), deleted_at: time.nullable(), row_version: integer,
});
export const projectDetailSchema = projectSchema.extend({ policy: executionPolicySchema });
export const routingRuleCreateSchema = z.strictObject({
  match: z.json(), preferred_agent_ids: z.array(uuid), position: integer,
});
export const routingRuleSchema = routingRuleCreateSchema.extend({
  id: uuid, project_id: uuid.nullable(), row_version: integer, deleted_at: time.nullable(),
});
export const pageSchema = (item: z.ZodType) => z.strictObject({ items: z.array(item), next_cursor: z.string().nullable() });
export const streamPageSchema = pageSchema;
