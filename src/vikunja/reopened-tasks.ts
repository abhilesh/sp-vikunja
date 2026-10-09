export interface ReopenedVikunjaRemoteTask {
  id: string;
  title: string;
  isDone?: boolean;
  vikunjaIsRecurring?: boolean;
}

export interface ArchivedVikunjaLocalTask {
  id: string;
  title?: string;
  isDone?: boolean;
  issueId?: string | null;
  issueProviderId?: string | null;
  issueType?: string | null;
}

export interface ReopenedVikunjaTaskMatch {
  remoteIssueId: string;
  remoteTitle: string;
  remoteIsRecurring?: boolean;
  archivedTaskId: string;
  archivedTaskTitle?: string;
}

const VIKUNJA_PLUGIN_ID = 'vikunja-super-productivity-plugin';
const VIKUNJA_ISSUE_TYPE = `plugin:${VIKUNJA_PLUGIN_ID}`;

function isCanonicalRemoteTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isVikunjaArchivedTask(task: ArchivedVikunjaLocalTask): boolean {
  return isCanonicalRemoteTaskId(task.issueId)
    && (task.issueType === VIKUNJA_ISSUE_TYPE || task.issueProviderId === VIKUNJA_PLUGIN_ID);
}

/**
 * Finds remote Vikunja tasks which are open again while their original
 * Super Productivity task is still in the archive.
 *
 * Vikunja reuses the same task ID for the next occurrence of a repeating task.
 * This is deliberately a pure classifier: restoring the task belongs to the
 * host and must never be emulated by creating a second local task.
 */
export function findReopenedVikunjaTasks(
  remoteTasks: ReopenedVikunjaRemoteTask[],
  archivedTasks: ArchivedVikunjaLocalTask[],
): ReopenedVikunjaTaskMatch[] {
  const archivedByIssueId = new Map<string, ArchivedVikunjaLocalTask>();
  const matches: ReopenedVikunjaTaskMatch[] = [];

  for (const task of archivedTasks) {
    if (isVikunjaArchivedTask(task) && task.issueId) {
      archivedByIssueId.set(task.issueId, task);
    }
  }

  for (const task of remoteTasks) {
    if (task.isDone === true || !isCanonicalRemoteTaskId(task.id)) {
      continue;
    }

    const archivedTask = archivedByIssueId.get(task.id);
    if (!archivedTask) {
      continue;
    }

    matches.push({
      remoteIssueId: task.id,
      remoteTitle: task.title,
      remoteIsRecurring: task.vikunjaIsRecurring,
      archivedTaskId: archivedTask.id,
      archivedTaskTitle: archivedTask.title,
    });
  }

  return matches;
}
