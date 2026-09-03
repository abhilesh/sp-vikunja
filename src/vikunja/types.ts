export interface VikunjaConnectionConfig {
  baseUrl: string;
}

export interface VikunjaTaskSummary {
  id: string;
  title: string;
  url?: string;
  status?: string;
  state?: string;
  isDone?: boolean;
  dueDay?: string;
  dueWithTime?: string;
  labels?: string[];
  labelIds?: string[];
  description?: string;
  projectId?: string;
  /** Remote project ID retained in sync metadata for post-import repair. */
  vikunjaProjectId?: string;
  priority?: number;
  dueDate?: string;
  lastUpdated?: number;
  projectTitle?: string;
  superProductivityProjectId?: string;
  vikunjaRelationsLoaded?: boolean;
  vikunjaParentTaskId?: string;
  vikunjaParentTaskAmbiguous?: boolean;
  vikunjaSubtaskTaskIds?: string[];
}

export interface VikunjaTaskDetails extends VikunjaTaskSummary {
  body?: string;
  assignee?: string;
  comments?: Array<{
    author: string;
    body: string;
    created: number;
  }>;
}

export interface IssueProviderHttpOptions {
  params?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
  responseType?: 'json' | 'text';
}

export interface IssueProviderHttp {
  get<T = unknown>(url: string, options?: IssueProviderHttpOptions): Promise<T>;
  post<T = unknown>(
    url: string,
    body: unknown,
    options?: IssueProviderHttpOptions,
  ): Promise<T>;
  put<T = unknown>(
    url: string,
    body: unknown,
    options?: IssueProviderHttpOptions,
  ): Promise<T>;
  patch<T = unknown>(
    url: string,
    body: unknown,
    options?: IssueProviderHttpOptions,
  ): Promise<T>;
  delete<T = unknown>(url: string, options?: IssueProviderHttpOptions): Promise<T>;
  request<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
    options?: IssueProviderHttpOptions,
  ): Promise<T>;
}

export interface IssueProviderConfigField {
  key: string;
  type: 'input' | 'password' | 'textarea' | 'checkbox' | 'select' | 'multiSelect' | 'link' | 'oauthButton';
  label: string;
  required?: boolean;
  description?: string;
  options?: Array<{ label: string; value: string }>;
  url?: string;
  pattern?: string;
  advanced?: boolean;
  showIf?: string;
  loadOptions?(
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<Array<{ label: string; value: string }>>;
}

export interface IssueProviderFieldDisplay {
  field: string;
  label: string;
  type?: 'text' | 'markdown' | 'link' | 'date' | 'list';
  linkField?: string;
  hideEmpty?: boolean;
}

export type IssueProviderSyncDirection = 'off' | 'pullOnly' | 'pushOnly' | 'both';

export interface IssueProviderFieldMapping {
  taskField:
    | 'isDone'
    | 'title'
    | 'notes'
    | 'dueDay'
    | 'dueWithTime'
    | 'timeEstimate'
    | 'tagIds';
  issueField: string;
  defaultDirection: IssueProviderSyncDirection;
  mutuallyExclusive?: string[];
  toIssueValue(taskValue: unknown, ctx: { issueId: string; issueNumber?: number }): unknown;
  toTaskValue(issueValue: unknown, ctx: { issueId: string; issueNumber?: number }): unknown;
}

/**
 * Super Productivity's current public field union does not include
 * `projectId`, but the host adapter accepts it at runtime. The plugin keeps
 * this pull-only extension isolated because removing it prevents imported
 * tasks from being assigned to their local mirrored project and the existing
 * 18.19/current-host compatibility path from repairing Inbox assignment.
 */
export interface VikunjaProjectAssignmentFieldMapping
  extends Omit<IssueProviderFieldMapping, 'taskField'> {
  taskField: 'projectId';
}

export type VikunjaIssueProviderFieldMapping =
  | IssueProviderFieldMapping
  | VikunjaProjectAssignmentFieldMapping;

export interface IssueProviderDefinition {
  configFields: IssueProviderConfigField[];
  getHeaders(
    config: Record<string, unknown>,
  ): Record<string, string> | Promise<Record<string, string>>;
  testConnection?(
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<boolean>;
  searchIssues(
    searchTerm: string,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<VikunjaTaskSummary[]>;
  getNewIssuesForBacklog?(
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<VikunjaTaskSummary[]>;
  getById(
    issueId: string,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<VikunjaTaskDetails>;
  getIssueLink(issueId: string, config: Record<string, unknown>): string;
  issueDisplay: IssueProviderFieldDisplay[];
  fieldMappings?: VikunjaIssueProviderFieldMapping[];
  extractSyncValues?(issue: unknown): Record<string, unknown>;
  updateIssue?(
    id: string,
    changes: Record<string, unknown>,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<void>;
  createIssue?(
    title: string,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<IssueProviderCreateResult>;
  deleteIssue?(
    id: string,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<void>;
}

export interface PluginDialogButton {
  label: string;
  icon?: string;
  onClick: () => void | Promise<void>;
  color?: 'primary' | 'warn';
}

export interface PluginDialogConfig {
  htmlContent?: string;
  buttons?: PluginDialogButton[];
}

export interface IssueProviderCreateInput {
  title: string;
  notes?: string;
  isDone?: boolean;
  dueDay?: string | null;
  dueWithTime?: string | number | null;
}

export interface PluginSecretAPI {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface IssueProviderCreateResult {
  issueId: string;
  issueNumber?: number;
  issueData: VikunjaTaskDetails;
}

export interface PluginAPI {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  registerIssueProvider(definition: IssueProviderDefinition): void;
  registerConfigHandler?(handler: () => void): void;
  registerHook?(
    hook: 'taskCreated' | 'taskUpdate',
    handler: (taskData: unknown) => void | Promise<void>,
  ): void;
  getTasks?(): Promise<Array<{
    id: string;
    projectId?: string | null;
    parentId?: string | null;
    issueId?: string | null;
    issueProviderId?: string | null;
    issueType?: string | null;
    issueLastSyncedValues?: Record<string, unknown>;
  }>>;
  updateTask?(taskId: string, updates: { projectId?: string | null; parentId?: string | null }): Promise<void>;
  getAllProjects?(): Promise<Array<{
    id: string;
    title: string;
    isArchived?: boolean;
  }>>;
  addProject?(projectData: {
    title: string;
  }): Promise<string>;
  updateProject?(projectId: string, updates: {
    title?: string;
  }): Promise<void>;
  registerHeaderButton?(headerButton: {
    label: string;
    icon?: string;
    onClick: () => void;
    color?: 'primary' | 'accent' | 'warn';
  }): void;
  registerMenuEntry?(menuEntry: {
    label: string;
    icon?: string;
    onClick: () => void;
    color?: 'primary' | 'accent' | 'warn';
  }): void;
  openDialog?(dialog: PluginDialogConfig): Promise<void>;
  /** Available on newer hosts; older hosts fall back to immediate startup work. */
  onReady?(handler: () => void | Promise<void>): void;
  onUnload?(handler: () => void | Promise<void>): void;
  showSnack?(snack: {
    msg: string;
    type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO';
    ico?: string;
  }): void;
}

export interface VikunjaPaginatedEnvelope<TItem> {
  items: TItem[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface VikunjaRawLabel {
  id: number;
  title: string;
}

export interface VikunjaRawRelatedTask {
  id: number;
  title: string;
  project_id?: number;
}

export type VikunjaRawRelatedTaskMap = Record<string, VikunjaRawRelatedTask[] | null>;

export interface VikunjaRawTask {
  id: number;
  title: string;
  description?: string;
  done?: boolean;
  project_id?: number;
  priority?: number;
  due_date?: string;
  updated?: string;
  labels?: VikunjaRawLabel[] | null;
  related_tasks?: VikunjaRawRelatedTaskMap | null;
}

export interface VikunjaRawProject {
  id: number;
  title: string;
  parent_project_id?: number | null;
  is_archived?: boolean;
}

export type VikunjaHeaderProvider = () => Promise<Record<string, string>>;

export type VikunjaLogEvent = {
  event: 'request' | 'request-failure';
  operation: string;
  status?: number;
};

export type VikunjaLogSink = (event: VikunjaLogEvent) => void;

export type VikunjaIssueState = 'done' | 'open';

export type VikunjaTaskUpdatePatch =
  | {
      done: boolean;
    }
  | {
      title: string;
    }
  | {
      description: string;
    }
  | {
      due_date: string;
    };

export interface VikunjaTaskCreatePayload {
  title: string;
  description?: string;
  done?: boolean;
  due_date?: string;
}
