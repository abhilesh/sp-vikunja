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
  priority?: number;
  dueDate?: string;
  lastUpdated?: number;
  projectTitle?: string;
  superProductivityProjectId?: string;
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
    | 'tagIds'
    | 'projectId';
  issueField: string;
  defaultDirection: IssueProviderSyncDirection;
  mutuallyExclusive?: string[];
  toIssueValue(taskValue: unknown, ctx: { issueId: string; issueNumber?: number }): unknown;
  toTaskValue(issueValue: unknown, ctx: { issueId: string; issueNumber?: number }): unknown;
}

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
  getById(
    issueId: string,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<VikunjaTaskDetails>;
  getIssueLink(issueId: string, config: Record<string, unknown>): string;
  issueDisplay: IssueProviderFieldDisplay[];
  fieldMappings?: IssueProviderFieldMapping[];
  updateIssue?(
    id: string,
    changes: Record<string, unknown>,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<void>;
  createIssue?(
    task: IssueProviderCreateInput,
    config: Record<string, unknown>,
    http: IssueProviderHttp,
  ): Promise<VikunjaTaskDetails>;
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

export interface PluginAPI {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  registerIssueProvider(definition: IssueProviderDefinition): void;
  registerHook?(hook: 'taskUpdate', handler: (taskData: unknown) => void | Promise<void>): void;
  updateTask?(taskId: string, updates: { projectId?: string | null }): Promise<void>;
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
  openDialog?(dialog: PluginDialogConfig): Promise<void>;
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
}

export interface VikunjaRawProject {
  id: number;
  title: string;
  parent_project_id?: number;
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
