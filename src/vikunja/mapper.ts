import type {
  VikunjaIssueState,
  VikunjaRawTask,
  VikunjaTaskDetails,
  VikunjaTaskSummary
} from './types.js';

export interface SuperProductivityIssueDisplay {
  field: string;
  label: string;
  type?: 'text' | 'markdown' | 'link' | 'date' | 'list';
  linkField?: string;
  hideEmpty?: boolean;
}

export interface VikunjaTaskMappingContext {
  projectTitle?: string;
  superProductivityProjectId?: string;
}

export const VIKUNJA_EMPTY_DUE_DATE = '0001-01-01T00:00:00.000Z';

export function normalizeVikunjaDueDate(value: string | undefined): string | undefined {
  if (!value || value.startsWith('0001-01-01T00:00:00')) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function normalizeDueDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Vikunja dueDay must be an ISO calendar date.');
  }

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error('Vikunja dueDay must be an ISO calendar date.');
  }

  return value;
}

export function normalizeDueWithTime(value: unknown): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Vikunja dueWithTime must be an ISO timestamp with timezone.');
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Vikunja dueWithTime must be an ISO timestamp with timezone.');
  }

  return parsed.toISOString();
}

export function toSuperProductivityDueWithTime(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Super Productivity dueWithTime must be a valid timestamp.');
    }

    return value;
  }

  return Date.parse(normalizeDueWithTime(value));
}

export function toVikunjaDueDateFromTime(value: unknown): string {
  if (typeof value === 'number') {
    return new Date(toSuperProductivityDueWithTime(value)).toISOString();
  }

  return normalizeDueWithTime(value);
}

export function toVikunjaDueDateFromDay(value: unknown): string {
  return `${normalizeDueDay(value)}T00:00:00.000Z`;
}

export function toDueDayFromIssueValue(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return normalizeDueDay(value);
  }

  return normalizeDueWithTime(value).slice(0, 10);
}

function mapTaskStatus(task: VikunjaRawTask): string {
  return task.done ? 'Done' : 'Open';
}

export function toIssueStateFromTaskDone(taskValue: unknown): VikunjaIssueState {
  if (typeof taskValue !== 'boolean') {
    throw new Error('Vikunja completion mapping requires a boolean isDone task value.');
  }

  return taskValue ? 'done' : 'open';
}

export function toTaskDoneFromIssueState(issueValue: unknown): boolean {
  if (issueValue === 'done') {
    return true;
  }

  if (issueValue === 'open') {
    return false;
  }

  throw new Error('Vikunja completion state must be "done" or "open".');
}

function toOptionalProjectId(projectId: number | undefined): string | undefined {
  return projectId === undefined ? undefined : String(projectId);
}

function toOptionalLastUpdated(updated: string | undefined): number | undefined {
  if (!updated) {
    return undefined;
  }

  const parsed = Date.parse(updated);

  return Number.isNaN(parsed) ? undefined : parsed;
}

function toOptionalLabelIds(labels: VikunjaRawTask['labels']): string[] | undefined {
  return labels?.map((label) => String(label.id));
}

function toMappedFields(
  task: VikunjaRawTask,
  context?: VikunjaTaskMappingContext,
): Omit<VikunjaTaskSummary, 'id' | 'title'> {
  const dueWithTime = normalizeVikunjaDueDate(task.due_date);
  const fields: Omit<VikunjaTaskSummary, 'id' | 'title'> = {
    description: task.description,
    isDone: task.done,
    state: toIssueStateFromTaskDone(task.done ?? false),
    status: mapTaskStatus(task),
    labels: task.labels?.map((label) => label.title),
    labelIds: toOptionalLabelIds(task.labels),
    projectId: toOptionalProjectId(task.project_id),
    priority: task.priority,
    lastUpdated: toOptionalLastUpdated(task.updated)
  };

  if (dueWithTime) {
    fields.dueDate = dueWithTime;
    fields.dueDay = dueWithTime.slice(0, 10);
    fields.dueWithTime = dueWithTime;
  }

  if (context?.projectTitle !== undefined) {
    fields.projectTitle = context.projectTitle;
  }

  if (context?.superProductivityProjectId !== undefined) {
    fields.superProductivityProjectId = context.superProductivityProjectId;
  }

  return fields;
}

export function toIssueDisplayFields(): SuperProductivityIssueDisplay[] {
  return [
    { field: 'title', label: 'Title' },
    { field: 'status', label: 'Status', hideEmpty: true },
    { field: 'description', label: 'Description', type: 'markdown', hideEmpty: true },
    { field: 'labels', label: 'Labels', type: 'list', hideEmpty: true },
    { field: 'projectTitle', label: 'Project', hideEmpty: true },
    { field: 'projectId', label: 'Project ID', hideEmpty: true },
    { field: 'priority', label: 'Priority', hideEmpty: true },
    { field: 'dueDate', label: 'Due Date', type: 'date', hideEmpty: true },
    { field: 'url', label: 'Remote Task', type: 'link', hideEmpty: true }
  ];
}

export function mapRawTaskToIssueSummary(
  task: VikunjaRawTask,
  context?: VikunjaTaskMappingContext,
): VikunjaTaskSummary {
  return {
    id: String(task.id),
    title: task.title,
    ...toMappedFields(task, context)
  };
}

export function mapRawTaskToIssueDetails(
  task: VikunjaRawTask,
  context?: VikunjaTaskMappingContext,
): VikunjaTaskDetails {
  return {
    ...mapRawTaskToIssueSummary(task, context),
    body: task.description
  };
}
