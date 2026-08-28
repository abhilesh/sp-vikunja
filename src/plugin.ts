import { getVikunjaApiToken } from './config/secrets.js';
import { DEFAULT_VIKUNJA_PROJECT_PREFIX, getLocalVikunjaProjectTitle, getRemoteIdFromLocalVikunjaProjectTitle, getVikunjaProjectPath } from './vikunja/project-path.js';
import { buildTaskFrontendUrl, createVikunjaClient } from './vikunja/client.js';
import {
  mapRawTaskToIssueDetails,
  mapRawTaskToIssueSummary,
  toIssueStateFromTaskDone,
  toTaskDoneFromIssueState,
  toIssueDisplayFields,
  normalizeDueDay,
  normalizeDueWithTime,
  toSuperProductivityDueWithTime,
  toVikunjaDueDateFromTime,
  toDueDayFromIssueValue,
  toVikunjaDueDateFromDay,
  VIKUNJA_EMPTY_DUE_DATE
} from './vikunja/mapper.js';
import type {
  IssueProviderDefinition,
  VikunjaIssueProviderFieldMapping,
  IssueProviderHttp,
  PluginAPI,
  PluginSecretAPI,
  IssueProviderCreateInput,
  IssueProviderCreateResult,
  VikunjaIssueState,
  PluginDialogConfig,
  VikunjaRawProject,
} from './vikunja/types.js';

interface HostPluginGlobal {
  PluginAPI?: PluginAPI;
}

// Super Productivity's plugin runner injects PluginAPI as a function
// parameter. The browser/global fallback keeps the bundle usable in hosts
// that expose the API on globalThis and preserves the standalone smoke-test
// entry point.
declare const PluginAPI: PluginAPI | undefined;

type VikunjaPluginHost = PluginSecretAPI & Partial<Pick<
  PluginAPI,
  'getTasks' | 'updateTask' | 'getAllProjects' | 'addProject' | 'updateProject'
>>;

function getSecretApi(api?: VikunjaPluginHost): PluginSecretAPI {
  if (!api) {
    throw new Error('Vikunja secret storage is not available in this host environment.');
  }

  return api;
}

async function getAuthenticatedHeaders(
  secretApi?: PluginSecretAPI,
): Promise<Record<string, string>> {
  const token = await getVikunjaApiToken(getSecretApi(secretApi));

  if (!token || !token.trim()) {
    throw new Error(
      'Vikunja API token is not configured. Store it in Super Productivity secret storage under vikunja.apiToken.',
    );
  }

  return {
    Authorization: `Bearer ${token}`
  };
}

function createAuthenticatedClient(
  config: Record<string, unknown>,
  http: IssueProviderHttp,
  secretApi?: PluginSecretAPI,
) {
  return createVikunjaClient({
    baseUrl: String(config.baseUrl ?? ''),
    http,
    getHeaders: async () => getAuthenticatedHeaders(secretApi)
  });
}

function parseProjectIds(config: Record<string, unknown>): number[] | undefined {
  const configured = config.projectIds;

  if (configured === undefined) {
    return undefined;
  }

  if (!Array.isArray(configured)) {
    throw new Error('Vikunja project IDs must be an array of integers.');
  }

  const projectIds = configured.map((value) => {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new Error('Vikunja project IDs must be an array of integers.');
    }

    const projectId = Number(value);

    if (!Number.isSafeInteger(projectId)) {
      throw new Error('Vikunja project IDs must be an array of integers.');
    }

    return projectId;
  });

  return [...new Set(projectIds)];
}


interface ProjectSyncContext {
  projectTitleById: Map<number, string>;
  localProjectIdByRemoteId: Map<number, string>;
}

function isProjectSyncEnabled(config: Record<string, unknown>): boolean {
  return config.syncProjects === true;
}

function parseProjectPrefix(config: Record<string, unknown>): string {
  const configured = config.projectPrefix;

  if (configured === undefined) {
    return DEFAULT_VIKUNJA_PROJECT_PREFIX;
  }

  if (typeof configured !== 'string') {
    throw new Error('Vikunja project prefix must be a string.');
  }

  return configured;
}

function getProjectSyncHost(api?: VikunjaPluginHost): VikunjaPluginHost {
  if (!api) {
    throw new Error('Super Productivity project APIs are unavailable.');
  }

  return api;
}


async function syncLocalVikunjaProjects(
  host: VikunjaPluginHost,
  projects: VikunjaRawProject[],
  projectsById: Map<number, VikunjaRawProject>,
  prefix: string,
): Promise<Map<number, string>> {
  if (!host.getAllProjects || !host.addProject) {
    throw new Error(
      'This Super Productivity version cannot mirror Vikunja projects. Update Super Productivity and try again.',
    );
  }

  const localProjects = await host.getAllProjects();
  const localProjectIdByRemoteId = new Map<number, string>();

  for (const project of projects) {
    if (project.id < 1 || project.is_archived === true) {
      continue;
    }

    const expectedTitle = getLocalVikunjaProjectTitle(project, projectsById, prefix);
    const existingProject = localProjects.find((candidate) => getRemoteIdFromLocalVikunjaProjectTitle(candidate.title) === project.id);

    if (existingProject) {
      if (existingProject.title !== expectedTitle && host.updateProject) {
        await host.updateProject(existingProject.id, { title: expectedTitle });
      }
      localProjectIdByRemoteId.set(project.id, existingProject.id);
      continue;
    }

    const localProjectId = await host.addProject({ title: expectedTitle });
    localProjectIdByRemoteId.set(project.id, localProjectId);
  }

  return localProjectIdByRemoteId;
}

async function loadProjectSyncContext(
  client: ReturnType<typeof createVikunjaClient>,
  host: VikunjaPluginHost,
  config: Record<string, unknown>,
): Promise<ProjectSyncContext> {
  const projects = await client.listProjects();
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const configuredProjectIds = parseProjectIds(config);
  const selectedProjects = configuredProjectIds === undefined || configuredProjectIds.length === 0
    ? projects
    : projects.filter((project) => configuredProjectIds.includes(project.id));
  const prefix = parseProjectPrefix(config);

  return {
    projectTitleById: new Map(projects.map((project) => [project.id, getVikunjaProjectPath(project, projectsById)])),
    localProjectIdByRemoteId: await syncLocalVikunjaProjects(host, selectedProjects, projectsById, prefix),
  };
}

function mapTaskWithProjectContext(
  task: Parameters<typeof mapRawTaskToIssueSummary>[0],
  context: ProjectSyncContext | undefined,
): ReturnType<typeof mapRawTaskToIssueSummary> {
  const projectId = task.project_id;

  return mapRawTaskToIssueSummary(task, context && projectId !== undefined
    ? {
        projectTitle: context.projectTitleById.get(projectId),
        superProductivityProjectId: context.localProjectIdByRemoteId.get(projectId),
      }
    : undefined);
}

function mapTaskDetailsWithProjectContext(
  task: Parameters<typeof mapRawTaskToIssueDetails>[0],
  context: ProjectSyncContext | undefined,
): ReturnType<typeof mapRawTaskToIssueDetails> {
  const projectId = task.project_id;

  return mapRawTaskToIssueDetails(task, context && projectId !== undefined
    ? {
        projectTitle: context.projectTitleById.get(projectId),
        superProductivityProjectId: context.localProjectIdByRemoteId.get(projectId),
      }
    : undefined);
}

function parseDefaultProjectId(config: Record<string, unknown>): number {
  const value = config.defaultProjectId;

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error('A default project must be configured in Vikunja before creating a task.');
  }

  const projectId = Number(value);

  if (!Number.isSafeInteger(projectId)) {
    throw new Error('A default project must be configured in Vikunja before creating a task.');
  }

  return projectId;
}

function parseCanonicalTaskId(issueId: string): number {
  if (!/^[1-9]\d*$/.test(issueId)) {
    throw new Error('Vikunja task IDs must be canonical positive integers.');
  }

  const taskId = Number(issueId);

  if (!Number.isSafeInteger(taskId)) {
    throw new Error('Vikunja task IDs must be canonical positive integers.');
  }

  return taskId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getOwnKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

function parseIssueCompletionState(value: unknown): VikunjaIssueState {
  return toTaskDoneFromIssueState(value) ? 'done' : 'open';
}

function parseIssueTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Vikunja task titles must be a non-empty string.');
  }

  return value;
}

function parseIssueDescription(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Vikunja task descriptions must be a string.');
  }

  return value;
}

function parseTagIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((tagId) => typeof tagId !== 'string')) {
    throw new Error('Vikunja tag IDs must be an array of strings.');
  }

  return [...value];
}

function getDefinedUpdateKeys(changes: Record<string, unknown>): string[] {
  return getOwnKeys(changes).filter((key) => changes[key] !== undefined);
}

function parseUpdatePatch(changes: Record<string, unknown>):
  { done: boolean } | { title: string } | { description: string } | { due_date: string } | null {
  const keys = getDefinedUpdateKeys(changes);

  if (keys.length === 0) {
    return null;
  }

  if (keys.length !== 1) {
    throw new Error('Vikunja updateIssue only supports one title, description, completion state, or due-date field at a time.');
  }

  const [key] = keys;

  if (key === 'title') {
    return {
      title: parseIssueTitle(changes.title)
    };
  }

  if (key === 'state') {
    return {
      done: toTaskDoneFromIssueState(parseIssueCompletionState(changes.state))
    };
  }

  if (key === 'description') {
    return {
      description: parseIssueDescription(changes.description)
    };
  }

  if (key === 'dueDay') {
    return {
      due_date: changes.dueDay === null
        ? VIKUNJA_EMPTY_DUE_DATE
        : toVikunjaDueDateFromDay(changes.dueDay)
    };
  }

  if (key === 'dueWithTime') {
    return {
      due_date: changes.dueWithTime === null
        ? VIKUNJA_EMPTY_DUE_DATE
        : toVikunjaDueDateFromTime(changes.dueWithTime)
    };
  }

  throw new Error('Vikunja updateIssue only supports title, description, completion state, or due-date fields.');
}

function buildCreatePayload(taskOrTitle: string | IssueProviderCreateInput): {
  title: string;
  description?: string;
  done?: boolean;
  due_date?: string;
} {
  const task: IssueProviderCreateInput = typeof taskOrTitle === 'string'
    ? { title: taskOrTitle }
    : taskOrTitle;

  if (!isRecord(task)) {
    throw new Error('Vikunja create task data must be an object.');
  }

  const allowed = new Set(['title', 'notes', 'isDone', 'dueDay', 'dueWithTime']);
  const unsupported = Object.keys(task).filter((key) => !allowed.has(key));

  if (unsupported.length > 0) {
    throw new Error(`Vikunja task creation does not support: ${unsupported.join(', ')}.`);
  }

  const payload: {
    title: string;
    description?: string;
    done?: boolean;
    due_date?: string;
  } = { title: parseIssueTitle(task.title) };

  if (task.notes !== undefined) {
    payload.description = parseIssueDescription(task.notes);
  }

  if (task.isDone !== undefined) {
    if (typeof task.isDone !== 'boolean') {
      throw new Error('Vikunja task completion must be a boolean.');
    }

    payload.done = task.isDone;
  }

  if (task.dueDay !== undefined && task.dueWithTime !== undefined) {
    throw new Error('Vikunja creation accepts only one due-date field.');
  }

  if (task.dueDay !== undefined && task.dueDay !== null) {
    payload.due_date = toVikunjaDueDateFromDay(task.dueDay);
  } else if (task.dueWithTime !== undefined && task.dueWithTime !== null) {
    payload.due_date = toVikunjaDueDateFromTime(task.dueWithTime);
  } else if (task.dueDay === null || task.dueWithTime === null) {
    payload.due_date = VIKUNJA_EMPTY_DUE_DATE;
  }

  return payload;
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = (error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }).status
    ?? (error as { statusCode?: unknown }).statusCode
    ?? (error as { response?: { status?: unknown } }).response?.status;

  return typeof candidate === 'number' ? candidate : undefined;
}

function isNetworkFailure(error: unknown): boolean {
  if (
    error
    && typeof error === 'object'
    && 'networkFailure' in error
    && (error as { networkFailure?: unknown }).networkFailure === true
  ) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    error.name === 'TypeError'
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('enotfound')
    || message.includes('econnrefused')
    || message.includes('eai_again')
  );
}

function normalizeConnectionError(error: unknown): Error {
  const status = getHttpStatus(error);

  if (
    error instanceof Error
    && error.message.toLowerCase().includes('api token')
  ) {
    return error;
  }

  if (status === 401 || status === 403) {
    return new Error(
      'Vikunja authentication failed. Check the token stored in Super Productivity secret storage.',
    );
  }

  if (isNetworkFailure(error)) {
    return new Error(
      'Unable to reach the Vikunja instance. Check the base URL and network access.',
    );
  }

  return error instanceof Error
    ? new Error('Vikunja connection test failed.')
    : new Error('Vikunja connection test failed.');
}

export function buildVikunjaIssueProviderDefinition(
  secretApi?: VikunjaPluginHost,
): IssueProviderDefinition {
  const fieldMappings: VikunjaIssueProviderFieldMapping[] = [
    {
      taskField: 'title',
      issueField: 'title',
      defaultDirection: 'both',
      toIssueValue(taskValue) {
        return parseIssueTitle(taskValue);
      },
      toTaskValue(issueValue) {
        return parseIssueTitle(issueValue);
      }
    },
    {
      taskField: 'isDone',
      issueField: 'state',
      defaultDirection: 'both',
      toIssueValue(taskValue) {
        return toIssueStateFromTaskDone(taskValue);
      },
      toTaskValue(issueValue) {
        return toTaskDoneFromIssueState(issueValue);
      }
    },
      {
        taskField: 'notes',
      issueField: 'description',
      defaultDirection: 'both',
      toIssueValue(taskValue) {
        return parseIssueDescription(taskValue);
      },
      toTaskValue(issueValue) {
        return parseIssueDescription(issueValue);
      }
    },
    {
      taskField: 'dueDay',
      issueField: 'dueDay',
      defaultDirection: 'both',
      toIssueValue(taskValue) {
        return taskValue === null || taskValue === undefined || taskValue === ''
          ? undefined
          : normalizeDueDay(taskValue);
      },
      toTaskValue(issueValue) {
        return issueValue === null || issueValue === undefined || issueValue === ''
          ? null
          : toDueDayFromIssueValue(issueValue);
      }
    },
    {
      taskField: 'dueWithTime',
      issueField: 'dueWithTime',
      defaultDirection: 'both',
      toIssueValue(taskValue) {
        return taskValue === null || taskValue === undefined || taskValue === ''
          ? undefined
          : toVikunjaDueDateFromTime(taskValue);
      },
      toTaskValue(issueValue) {
        return issueValue === null || issueValue === undefined || issueValue === ''
          ? null
          : toSuperProductivityDueWithTime(issueValue);
      }
    },
    {
      taskField: 'projectId',
      issueField: 'superProductivityProjectId',
      defaultDirection: 'pullOnly',
      toIssueValue(taskValue) {
        return typeof taskValue === 'string' && taskValue ? taskValue : undefined;
      },
      toTaskValue(issueValue) {
        if (issueValue === null || issueValue === undefined || issueValue === '') {
          return null;
        }

        if (typeof issueValue !== 'string') {
          throw new Error('Super Productivity project IDs must be strings.');
        }

        return issueValue;
      }
    },
    {
      taskField: 'tagIds',
      issueField: 'labelIds',
      defaultDirection: 'pullOnly',
      toIssueValue(taskValue) {
        return parseTagIds(taskValue);
      },
      toTaskValue(issueValue) {
        return parseTagIds(issueValue);
      }
    }
  ];

  return {
    configFields: [
      {
        key: 'baseUrl',
        type: 'input',
        label: 'Vikunja base URL',
        required: true,
        description: 'The local or remote Vikunja instance URL.'
      },
      {
        key: 'projectPrefix',
        type: 'input',
        label: 'Local project prefix',
        description: `Literal prefix for local Vikunja project mirrors; leave empty for no prefix. Default: ${DEFAULT_VIKUNJA_PROJECT_PREFIX}`
      },
      {
        key: 'projectIds',
        type: 'multiSelect',
        label: 'Vikunja projects',
        description: 'Leave empty to search all accessible, non-archived projects.',
        loadOptions: async (config, http) => {
          const client = createAuthenticatedClient(config, http, secretApi);
          const projects = await client.listProjects();

          const projectsById = new Map(projects.map((project) => [project.id, project]));
          return projects
            .filter((project) => project.is_archived !== true)
            .map((project) => ({
              label: `${getVikunjaProjectPath(project, projectsById)} (ID ${project.id})`,
              value: String(project.id)
            }));
        }
      },
      {
        key: 'syncProjects',
        type: 'checkbox',
        label: 'Mirror Vikunja projects locally',
        description: 'Create or rename local project mirrors for selected Vikunja projects using their full path and stable ID. This only changes local Super Productivity projects.'
      },
      {
        key: 'defaultProjectId',
        type: 'select',
        label: 'Default project for new tasks',
        description: 'Required when creating a Vikunja task.',
        loadOptions: async (config, http) => {
          const client = createAuthenticatedClient(config, http, secretApi);
          const projects = await client.listProjects();
          const projectsById = new Map(projects.map((project) => [project.id, project]));

          return projects
            .filter((project) => project.is_archived !== true && project.id > 0)
            .map((project) => ({
              label: `${getVikunjaProjectPath(project, projectsById)} (ID ${project.id})`,
              value: String(project.id)
            }));
        }
      }
    ],
    async getHeaders() {
      return getAuthenticatedHeaders(secretApi);
    },
    async testConnection(config, http: IssueProviderHttp) {
      const client = createAuthenticatedClient(config, http, secretApi);

      try {
        await client.listProjects({ page: 1, perPage: 1 });
        return true;
      } catch (error) {
        throw normalizeConnectionError(error);
      }
    },
    async searchIssues(searchTerm, config, http: IssueProviderHttp) {
      const projectIds = parseProjectIds(config);
      const client = createAuthenticatedClient(config, http, secretApi);
      const projectContext = isProjectSyncEnabled(config)
        ? await loadProjectSyncContext(client, getProjectSyncHost(secretApi), config)
        : undefined;
      const tasks = await client.searchTasks(searchTerm, { includeSubtasks: true });
      const filteredTasks = projectIds === undefined || projectIds.length === 0
        ? tasks
        : tasks.filter((task) => task.project_id !== undefined && projectIds.includes(task.project_id));

      return filteredTasks.map((task) => mapTaskWithProjectContext(task, projectContext));
    },
    async getById(issueId, config, http: IssueProviderHttp) {
      const taskId = parseCanonicalTaskId(issueId);

      const client = createAuthenticatedClient(config, http, secretApi);
      const task = await client.getTaskById(taskId, { includeSubtasks: true });
      const projectContext = isProjectSyncEnabled(config)
        ? await loadProjectSyncContext(client, getProjectSyncHost(secretApi), config)
        : undefined;

      return mapTaskDetailsWithProjectContext(task, projectContext);
    },
    getIssueLink(issueId, config) {
      const taskId = parseCanonicalTaskId(issueId);

      return buildTaskFrontendUrl(String(config.baseUrl ?? ''), taskId);
    },
    fieldMappings,
    extractSyncValues(issue) {
      if (!isRecord(issue)) {
        return {};
      }

      const parentTaskId = issue.vikunjaParentTaskAmbiguous === true
        ? null
        : typeof issue.vikunjaParentTaskId === 'string' && /^[1-9]\d*$/.test(issue.vikunjaParentTaskId)
          ? issue.vikunjaParentTaskId
          : null;
      const subtaskTaskIds = Array.isArray(issue.vikunjaSubtaskTaskIds)
        ? [...new Set(issue.vikunjaSubtaskTaskIds.filter((id): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id)))]
        : [];

      return {
        vikunjaRelationsLoaded: issue.vikunjaRelationsLoaded === true,
        vikunjaParentTaskId: parentTaskId,
        vikunjaParentTaskAmbiguous: issue.vikunjaParentTaskAmbiguous === true,
        vikunjaSubtaskTaskIds: subtaskTaskIds,
      };
    },
    async updateIssue(issueId, changes, config, http) {
      const taskId = parseCanonicalTaskId(issueId);

      if (!isRecord(changes)) {
        throw new Error('Vikunja update changes must be an object.');
      }

      const patch = parseUpdatePatch(changes);

      if (!patch) {
        return;
      }

      const client = createAuthenticatedClient(config, http, secretApi);
      await client.updateTask(taskId, patch);
    },
    async createIssue(
      titleOrTask: string | IssueProviderCreateInput,
      config,
      http,
    ): Promise<IssueProviderCreateResult> {
      const projectId = parseDefaultProjectId(config);
      const payload = buildCreatePayload(titleOrTask);
      const client = createAuthenticatedClient(config, http, secretApi);

      try {
        const createdTask = await client.createTask(projectId, payload);
        const issueData = {
          ...mapRawTaskToIssueDetails(createdTask),
          url: buildTaskFrontendUrl(String(config.baseUrl ?? ''), createdTask.id)
        };

        return {
          issueId: String(createdTask.id),
          issueNumber: createdTask.id,
          issueData,
          // Super Productivity 18.19 accepted the older object-based result
          // directly. Keeping the mapped fields at the top level is harmless
          // to the current host and preserves that runtime compatibility.
          ...issueData,
        };
      } catch (error) {
        if (isNetworkFailure(error)) {
          const reconciliationError = new Error(
            'Vikunja task creation response was uncertain. Reconcile the remote task before retrying.',
          );
          Object.assign(reconciliationError, { reconciliationRequired: true });
          throw reconciliationError;
        }

        throw error;
      }
    },
    issueDisplay: toIssueDisplayFields()
  };
}

export function registerVikunjaIssueProvider(api: PluginAPI): void {
  api.registerIssueProvider(buildVikunjaIssueProviderDefinition(api));
  registerVikunjaTokenButton(api);
  registerVikunjaProjectAssignmentHook(api);
}

const VIKUNJA_TOKEN_INPUT_ID = 'vikunja-plugin-api-token-input';

async function saveVikunjaTokenFromDialog(api: PluginAPI): Promise<void> {
  const input = document.getElementById(VIKUNJA_TOKEN_INPUT_ID);
  const value = input instanceof HTMLInputElement ? input.value.trim() : '';

  if (!value) {
    api.showSnack?.({
      msg: 'No Vikunja API token entered.',
      type: 'ERROR',
      ico: 'warning'
    });
    return;
  }

  await api.setSecret('vikunja.apiToken', value);

  if (input instanceof HTMLInputElement) {
    input.value = '';
  }

  api.showSnack?.({
    msg: 'Vikunja API token stored in local secret storage.',
    type: 'SUCCESS',
    ico: 'lock'
  });
}

function createVikunjaTokenDialog(api: PluginAPI): PluginDialogConfig {
  return {
    htmlContent: `
      <label for="${VIKUNJA_TOKEN_INPUT_ID}">Vikunja API token</label>
      <input id="${VIKUNJA_TOKEN_INPUT_ID}" type="password" autocomplete="off" spellcheck="false" />
      <p>Stored locally in Super Productivity secret storage; it is not part of provider configuration or sync data.</p>
    `,
    buttons: [
      {
        label: 'Save token',
        icon: 'save',
        onClick: () => saveVikunjaTokenFromDialog(api)
      }
    ]
  };
}

function registerVikunjaTokenButton(api: PluginAPI): void {
  if (!api.registerHeaderButton || !api.openDialog) {
    return;
  }

  api.registerHeaderButton({
    label: 'Set Vikunja Token',
    icon: 'key',
    onClick: () => {
      void api.openDialog?.(createVikunjaTokenDialog(api));
    }
  });
}


const VIKUNJA_PLUGIN_ID = 'vikunja-super-productivity-plugin';

interface LocalTaskHierarchyRecord {
  id: string;
  parentId?: string | null;
  issueId?: string | null;
  issueProviderId?: string | null;
}

function isCanonicalRemoteTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isLocalTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isVikunjaLinkedTask(task: LocalTaskHierarchyRecord): boolean {
  return isCanonicalRemoteTaskId(task.issueId)
    && (task.issueProviderId === undefined
      || task.issueProviderId === null
      || task.issueProviderId === VIKUNJA_PLUGIN_ID);
}

function wouldCreateLocalTaskCycle(
  tasks: LocalTaskHierarchyRecord[],
  childTaskId: string,
  parentTaskId: string,
): boolean {
  let currentTaskId: string | undefined = parentTaskId;
  const visited = new Set<string>();

  while (currentTaskId) {
    if (currentTaskId === childTaskId) {
      return true;
    }

    if (visited.has(currentTaskId)) {
      return true;
    }
    visited.add(currentTaskId);

    const parentTask = tasks.find((task) => task.id === currentTaskId);
    if (!parentTask || !isLocalTaskId(parentTask.parentId)) {
      return false;
    }
    currentTaskId = parentTask.parentId;
  }

  return false;
}

function registerVikunjaProjectAssignmentHook(api: PluginAPI): void {
  if (!api.registerHook || !api.updateTask) {
    return;
  }

  const updateTask = api.updateTask;
  const updatingTaskIds = new Set<string>();

  const applyLocalUpdate = async (
    taskId: string,
    updates: { projectId?: string | null; parentId?: string | null },
  ): Promise<void> => {
    if (updatingTaskIds.has(taskId)) {
      return;
    }

    updatingTaskIds.add(taskId);
    try {
      await updateTask(taskId, updates);
    } finally {
      updatingTaskIds.delete(taskId);
    }
  };

  api.registerHook('taskUpdate', async (taskData) => {
    if (!isRecord(taskData)) {
      return;
    }

    const taskId = taskData.id;
    const syncValues = taskData.issueLastSyncedValues;

    if (
      typeof taskId !== 'string'
      || !isRecord(syncValues)
      || updatingTaskIds.has(taskId)
    ) {
      return;
    }

    const updates: { projectId?: string | null; parentId?: string | null } = {};
    if (
      typeof syncValues.superProductivityProjectId === 'string'
      && taskData.projectId !== syncValues.superProductivityProjectId
    ) {
      updates.projectId = syncValues.superProductivityProjectId;
    }

    let linkedTasks: LocalTaskHierarchyRecord[] = [];
    if (syncValues.vikunjaRelationsLoaded === true && api.getTasks) {
      try {
        linkedTasks = await api.getTasks();
      } catch {
        linkedTasks = [];
      }
    }

    const linkedTaskByRemoteId = new Map<string, LocalTaskHierarchyRecord>();
    for (const task of linkedTasks) {
      if (isVikunjaLinkedTask(task)) {
        linkedTaskByRemoteId.set(task.issueId as string, task);
      }
    }

    if (syncValues.vikunjaRelationsLoaded === true) {
      const parentRemoteId = syncValues.vikunjaParentTaskAmbiguous === true
        ? undefined
        : isCanonicalRemoteTaskId(syncValues.vikunjaParentTaskId)
          ? syncValues.vikunjaParentTaskId
          : undefined;
      const localParent = parentRemoteId ? linkedTaskByRemoteId.get(parentRemoteId) : undefined;

      if (
        localParent
        && localParent.id !== taskId
        && taskData.parentId !== localParent.id
        && !wouldCreateLocalTaskCycle(linkedTasks, taskId, localParent.id)
      ) {
        updates.parentId = localParent.id;
      }
    }

    if (Object.keys(updates).length > 0) {
      await applyLocalUpdate(taskId, updates);
    }

    if (syncValues.vikunjaRelationsLoaded !== true) {
      return;
    }

    const childRemoteIds = Array.isArray(syncValues.vikunjaSubtaskTaskIds)
      ? syncValues.vikunjaSubtaskTaskIds.filter(isCanonicalRemoteTaskId)
      : [];

    for (const childRemoteId of childRemoteIds) {
      const localChild = linkedTaskByRemoteId.get(childRemoteId);
      if (
        !localChild
        || localChild.id === taskId
        || localChild.parentId === taskId
        || wouldCreateLocalTaskCycle(linkedTasks, localChild.id, taskId)
      ) {
        continue;
      }

      await applyLocalUpdate(localChild.id, { parentId: taskId });
    }
  });
}
function getHostPluginAPI(): PluginAPI | undefined {
  const globalApi = (globalThis as typeof globalThis & HostPluginGlobal).PluginAPI;

  if (globalApi) {
    return globalApi;
  }

  return typeof PluginAPI === 'undefined' ? undefined : PluginAPI;
}

const hostPluginAPI = getHostPluginAPI();

if (hostPluginAPI) {
  registerVikunjaIssueProvider(hostPluginAPI);
}
