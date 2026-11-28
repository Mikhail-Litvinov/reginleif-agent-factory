// PrepareTask (temporal.md "Activities"): local, key task id + revision, read only, so a retry returns the same
// snapshot. Non-retryable on an unknown task or revision: the workflow turns it into BLOCKED `execution`.
import { ApplicationFailure } from "@temporalio/activity";
import type { Repo } from "../../db/repo/index.ts";

export const UNKNOWN_TASK = "UnknownTask";

export interface PrepareTaskInput { taskId: string; revision: number }
export interface PreparedTask {
	taskId: string;
	revision: number;
	projectId: string | null;
	title: string | null;
	description: string | null;
	priority: number | null;
	requirements: string | null;
	acceptanceCriteria: unknown;
	constraints: unknown;
	/** Where a run's worktree is cut from: the project's repository and default branch (null without a project). */
	repositoryUrl: string | null;
	defaultBranch: string | null;
}

export const PrepareTask = async (repo: Pick<Repo, "tasks" | "projects">, { taskId, revision }: PrepareTaskInput): Promise<PreparedTask> => {
	const task = await repo.tasks.get(taskId);
	if (!task) throw ApplicationFailure.nonRetryable(`unknown task ${taskId}`, UNKNOWN_TASK);
	const rev = await repo.tasks.getRevision(taskId, revision);
	if (!rev) throw ApplicationFailure.nonRetryable(`unknown revision ${revision} of task ${taskId}`, UNKNOWN_TASK);
	const project = task.projectId === null ? null : await repo.projects.get(task.projectId);
	return {
		taskId, revision, projectId: task.projectId, title: task.title, description: task.description, priority: task.priority,
		requirements: rev.requirements, acceptanceCriteria: rev.acceptanceCriteria, constraints: rev.constraints,
		repositoryUrl: project?.repositoryUrl ?? null, defaultBranch: project?.defaultBranch ?? null,
	};
};
