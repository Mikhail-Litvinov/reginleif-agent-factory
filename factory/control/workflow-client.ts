// WorkflowClient (modules.md Phase 3): the API and the outbox relay reach Temporal only through this interface. An
// Update carries only a decision id (D-rule: the workflow reads the content from PostgreSQL by a local activity), and
// the Update id equals the outbox row id, so a repeat of the same row is the same Update (temporal.md "handled").
import { Client, WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/client";

export const CONTROL_QUEUE = "control";
export const taskWorkflowId = (taskId: string): string => `task-${taskId}`;

export interface WorkflowClient {
	/** Starts TaskWorkflow `task-<taskId>` on queue `control`. A running workflow of that id is kept (no second start, no error). */
	readonly startTask: (taskId: string) => Promise<{ readonly workflowId: string; readonly started: boolean }>;
	/** Sends one Update of a decision kind (`updateName`, one of the 12 of temporal.md) with only the decision id. Returns the workflow's outcome. */
	readonly sendDecision: (taskId: string, updateName: string, decisionId: string) => Promise<unknown>;
	/** Signal `wake` (temporal.md): re-run a wait on dependencies or machines. */
	readonly wake: (taskId: string) => Promise<void>;
}

export interface DecisionUpdateArgs {
	readonly decisionId: string;
}

/** Real implementation over a connected SDK `Client`. `workflowType` is the exported function name of workflows/task.ts. */
export const createWorkflowClient = (client: Client, workflowType = "TaskWorkflow"): WorkflowClient => ({
	startTask: async (taskId) => {
		const workflowId = taskWorkflowId(taskId);
		try {
			await client.workflow.start(workflowType, {
				taskQueue: CONTROL_QUEUE,
				workflowId,
				args: [{ taskId }],
				// The relay decides from PostgreSQL whether a task may start (temporal.md:20-22); the server side only
				// refuses a second start of an id, a closed one included, so an expired history cannot restart a task.
				workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
				workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
			});
			return { workflowId, started: true };
		} catch (error) {
			if ((error as { name?: string }).name === "WorkflowExecutionAlreadyStartedError") return { workflowId, started: false };
			throw error;
		}
	},
	sendDecision: (taskId, updateName, decisionId) =>
		client.workflow.getHandle(taskWorkflowId(taskId)).executeUpdate(updateName, { updateId: decisionId, args: [{ decisionId } satisfies DecisionUpdateArgs] }),
	wake: (taskId) => client.workflow.getHandle(taskWorkflowId(taskId)).signal("wake"),
});
