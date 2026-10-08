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
  VikunjaTaskSummary,
  PluginBatchTaskUpdate,
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
  'getTasks' | 'updateTask' | 'batchUpdateForProject' | 'getAllProjects' | 'addProject' | 'updateProject' | 'openDialog' | 'showSnack'
>>;

interface PollTimestampSnapshot {
  remoteTimestamp: number;
  hostTimestamp: number;
}

let vikunjaTokenDialogPromise: Promise<void> | null = null;
let vikunjaProjectCreationPromptPromise: Promise<boolean> | null = null;
const vikunjaProjectSyncLocks = new Map<string, Promise<void>>();

async function withVikunjaProjectSyncLock<T>(
  baseUrl: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeVikunjaServerKey(baseUrl);
  const previous = vikunjaProjectSyncLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  vikunjaProjectSyncLocks.set(key, current);

  try {
    if (previous) {
      await previous;
    }
    return await operation();
  } finally {
    release();
    if (vikunjaProjectSyncLocks.get(key) === current) {
      vikunjaProjectSyncLocks.delete(key);
    }
  }
}

function getHostComparableLastUpdated(
  issueId: string,
  baseUrl: string,
  remoteTimestamp: number | undefined,
  snapshots: Map<string, PollTimestampSnapshot>,
): number | undefined {
  if (remoteTimestamp === undefined) {
    return undefined;
  }

  const key = `${baseUrl}\u0000${issueId}`;
  const previous = snapshots.get(key);

  // Some Vikunja installations have a server clock behind the local desktop.
  // Super Productivity compares lastUpdated against a local Date.now() import
  // baseline, so the real remote timestamp can be rejected even though the
  // task changed. Keep a stable local comparison value for an unchanged remote
  // timestamp, and advance it only when Vikunja reports a new timestamp.
  if (previous?.remoteTimestamp === remoteTimestamp) {
    return previous.hostTimestamp;
  }

  const hostTimestamp = Math.max(
    remoteTimestamp,
    Date.now(),
    (previous?.hostTimestamp ?? 0) + 1,
  );
  snapshots.set(key, { remoteTimestamp, hostTimestamp });

  return hostTimestamp;
}

function getSecretApi(api?: VikunjaPluginHost): VikunjaPluginHost {
  if (!api) {
    throw new Error('Vikunja secret storage is not available in this host environment.');
  }

  return api;
}

async function getAuthenticatedHeaders(
  secretApi?: VikunjaPluginHost,
): Promise<Record<string, string>> {
  const api = getSecretApi(secretApi);
  let token = await getVikunjaApiToken(api);

  if (!token || !token.trim()) {
    await openVikunjaTokenDialog(api);
    token = await getVikunjaApiToken(api);
  }

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
  secretApi?: VikunjaPluginHost,
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
  archivedProjectIds: Set<number>;
  selectedProjectIds: Set<number> | undefined;
}

interface ProjectSyncContextCacheEntry {
  expiresAt: number;
  promise: Promise<ProjectSyncContext>;
}

interface VikunjaTaskSummaryOptions {
  activeOnly?: boolean;
  refreshProjectContext?: boolean;
  projectSyncContextCache?: Map<string, ProjectSyncContextCacheEntry>;
}

const PROJECT_SYNC_CONTEXT_CACHE_TTL_MS = 300_000;

function isProjectSyncEnabled(config: Record<string, unknown>): boolean {
  return config.syncProjects === true;
}

function parseProjectPrefix(config: Record<string, unknown>): string {
  const configured = config.projectPrefix;

  if (configured === undefined || configured === null) {
    return '';
  }

  if (typeof configured !== 'string') {
    throw new Error('Vikunja project prefix must be a string.');
  }

  return configured;
}

function getSelectedVikunjaProjectIds(
  projects: VikunjaRawProject[],
  configuredProjectIds: number[] | undefined,
): Set<number> | undefined {
  if (configuredProjectIds === undefined || configuredProjectIds.length === 0) {
    return undefined;
  }

  const configuredIds = new Set(configuredProjectIds);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const selectedProjectIds = new Set<number>();

  for (const project of projects) {
    const visited = new Set<number>();
    let current: VikunjaRawProject | undefined = project;

    while (current && !visited.has(current.id)) {
      if (configuredIds.has(current.id)) {
        selectedProjectIds.add(project.id);
        break;
      }

      visited.add(current.id);
      const parentId: number | null | undefined = current.parent_project_id;
      current = parentId === undefined || parentId === null
        ? undefined
        : projectsById.get(parentId);
    }
  }

  return selectedProjectIds;
}

function getProjectSyncHost(api?: VikunjaPluginHost): VikunjaPluginHost {
  if (!api) {
    throw new Error('Super Productivity project APIs are unavailable.');
  }

  return api;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeVikunjaServerKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

function getVikunjaProjectSkipKey(baseUrl: string, projectId: number): string {
  return `${normalizeVikunjaServerKey(baseUrl)}::${projectId}`;
}

function loadSkippedVikunjaProjectKeys(): string[] {
  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_SKIPPED_PROJECTS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistSkippedVikunjaProjectKeys(keys: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(
      VIKUNJA_SKIPPED_PROJECTS_STORAGE_KEY,
      JSON.stringify([...keys]),
    );
  } catch {
    // Local storage can be unavailable in restricted host profiles. The
    // in-memory set still suppresses duplicate prompts for this session.
  }
}

function loadVikunjaProjectMappings(baseUrl: string): Map<number, string> {
  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_PROJECT_MAPPINGS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    const serverKey = normalizeVikunjaServerKey(baseUrl);
    const scoped = isRecord(parsed) && isRecord(parsed[serverKey]) ? parsed[serverKey] : {};
    const mappings = new Map<number, string>();

    for (const [remoteId, localId] of Object.entries(scoped)) {
      const parsedRemoteId = Number(remoteId);
      if (/^[1-9]\d*$/.test(remoteId) && Number.isSafeInteger(parsedRemoteId) && typeof localId === 'string' && localId) {
        mappings.set(parsedRemoteId, localId);
      }
    }

    return mappings;
  } catch {
    return new Map();
  }
}

function persistVikunjaProjectMappings(baseUrl: string, mappings: Map<number, string>): void {
  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_PROJECT_MAPPINGS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    const scopes = isRecord(parsed) ? { ...parsed } : {};
    scopes[normalizeVikunjaServerKey(baseUrl)] = Object.fromEntries(
      [...mappings].map(([remoteId, localId]) => [String(remoteId), localId]),
    );
    globalThis.localStorage?.setItem(VIKUNJA_PROJECT_MAPPINGS_STORAGE_KEY, JSON.stringify(scopes));
  } catch {
    // Project names and legacy markers remain a fallback when local storage is unavailable.
  }
}

function persistVikunjaTaskProjectMappings(
  baseUrl: string,
  mappings: Map<string, string>,
): void {
  const serverKey = normalizeVikunjaServerKey(baseUrl);
  for (const [remoteTaskId, localProjectId] of mappings) {
    if (isCanonicalRemoteTaskId(remoteTaskId) && localProjectId) {
      vikunjaTaskProjectMappings.set(
        serverKey + '::' + remoteTaskId,
        localProjectId,
      );
    }
  }

  if (mappings.size === 0) {
    return;
  }

  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_TASK_PROJECT_MAPPINGS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    const scopes = isRecord(parsed) ? { ...parsed } : {};
    const scoped = isRecord(scopes[serverKey]) ? { ...scopes[serverKey] } : {};

    for (const [remoteTaskId, localProjectId] of mappings) {
      if (isCanonicalRemoteTaskId(remoteTaskId) && localProjectId) {
        scoped[remoteTaskId] = localProjectId;
      }
    }

    scopes[serverKey] = scoped;
    globalThis.localStorage?.setItem(
      VIKUNJA_TASK_PROJECT_MAPPINGS_STORAGE_KEY,
      JSON.stringify(scopes),
    );
  } catch {
    // In-memory mappings still cover the current session if browser storage is unavailable.
  }
}

function getStoredVikunjaTaskProjectId(remoteTaskId: string): string | undefined {
  const localProjectIds = new Set<string>();
  const suffix = '::' + remoteTaskId;

  for (const [key, localProjectId] of vikunjaTaskProjectMappings) {
    if (key.endsWith(suffix)) {
      localProjectIds.add(localProjectId);
    }
  }

  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_TASK_PROJECT_MAPPINGS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};

    if (isRecord(parsed)) {
      for (const scoped of Object.values(parsed)) {
        if (isRecord(scoped) && typeof scoped[remoteTaskId] === 'string' && scoped[remoteTaskId]) {
          localProjectIds.add(scoped[remoteTaskId]);
        }
      }
    }
  } catch {
    // Use any in-memory mapping available.
  }

  return localProjectIds.size === 1 ? [...localProjectIds][0] : undefined;
}

function getStoredVikunjaLocalProjectId(remoteProjectId: string): string | undefined {
  const localProjectIds = new Set<string>();

  try {
    const stored = globalThis.localStorage?.getItem(VIKUNJA_PROJECT_MAPPINGS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};

    if (isRecord(parsed)) {
      for (const scoped of Object.values(parsed)) {
        if (isRecord(scoped) && typeof scoped[remoteProjectId] === 'string' && scoped[remoteProjectId]) {
          localProjectIds.add(scoped[remoteProjectId]);
        }
      }
    }
  } catch {
    // A task-level mapping or the current session's in-memory data may still be usable.
  }

  return localProjectIds.size === 1 ? [...localProjectIds][0] : undefined;
}

async function confirmCreateMissingLocalProjects(
  host: VikunjaPluginHost,
  missingProjects: Array<{ project: VikunjaRawProject; title: string }>,
  baseUrl: string,
): Promise<boolean> {
  if (!host.openDialog) {
    return true;
  }

  const projectsToAskAbout = missingProjects.filter(({ project }) =>
    !vikunjaSkippedProjectKeys.has(getVikunjaProjectSkipKey(baseUrl, project.id)),
  );
  if (projectsToAskAbout.length === 0) {
    return false;
  }

  if (!vikunjaProjectCreationPromptPromise) {
    vikunjaProjectCreationPromptPromise = (async () => {
      let shouldCreate = false;
      const visibleProjects = projectsToAskAbout.slice(0, 20)
        .map(({ title }) => `<li>${escapeHtml(title)}</li>`)
        .join('');
      const remainingCount = projectsToAskAbout.length - Math.min(projectsToAskAbout.length, 20);
      const remainingText = remainingCount > 0
        ? `<li>…and ${remainingCount} more</li>`
        : '';

      await host.openDialog?.({
        htmlContent: `
          <p><strong>Missing local Vikunja projects</strong></p>
          <p>Super Productivity does not have local mirrors for these Vikunja projects:</p>
          <ul>${visibleProjects}${remainingText}</ul>
          <p>Create the missing projects now and place imported tasks in their matching mirrors?</p>
        `,
        buttons: [
          {
            label: 'Create local projects',
            icon: 'add',
            onClick: () => {
              shouldCreate = true;
            },
          },
          {
            label: 'Skip',
            onClick: () => undefined,
          },
        ],
      });

      return shouldCreate;
    })().finally(() => {
      vikunjaProjectCreationPromptPromise = null;
    });
  }

  const shouldCreate = await vikunjaProjectCreationPromptPromise;
  if (!shouldCreate) {
    for (const { project } of projectsToAskAbout) {
      vikunjaSkippedProjectKeys.add(getVikunjaProjectSkipKey(baseUrl, project.id));
    }
    persistSkippedVikunjaProjectKeys(vikunjaSkippedProjectKeys);
  }

  return shouldCreate;
}


async function syncLocalVikunjaProjectsUnlocked(
  host: VikunjaPluginHost,
  projects: VikunjaRawProject[],
  projectsById: Map<number, VikunjaRawProject>,
  prefix: string,
  baseUrl: string,
): Promise<Map<number, string>> {
  if (!host.getAllProjects || !host.addProject) {
    throw new Error(
      'This Super Productivity version cannot mirror Vikunja projects. Update Super Productivity and try again.',
    );
  }

  const localProjects = await host.getAllProjects();
  const localProjectIdByRemoteId = new Map<number, string>();
  const localProjectMappings = loadVikunjaProjectMappings(baseUrl);
  const missingProjects: Array<{ project: VikunjaRawProject; title: string }> = [];
  let mappingsChanged = false;

  for (const project of projects) {
    if (project.id < 1) {
      continue;
    }

    const expectedTitle = getLocalVikunjaProjectTitle(project, projectsById, prefix);
    const mappedProject = localProjects.find((candidate) => candidate.id === localProjectMappings.get(project.id));
    const markedProject = localProjects.find((candidate) => getRemoteIdFromLocalVikunjaProjectTitle(candidate.title) === project.id);
    const titleMatches = localProjects.filter((candidate) => candidate.title === expectedTitle);
    const existingProject = mappedProject ?? markedProject ?? (titleMatches.length === 1 ? titleMatches[0] : undefined);

    if (existingProject) {
      if (localProjectMappings.get(project.id) !== existingProject.id) {
        localProjectMappings.set(project.id, existingProject.id);
        mappingsChanged = true;
      }
      if (existingProject.title !== expectedTitle && host.updateProject) {
        await host.updateProject(existingProject.id, { title: expectedTitle });
      }
      localProjectIdByRemoteId.set(project.id, existingProject.id);
      continue;
    }

    missingProjects.push({ project, title: expectedTitle });
  }

  if (mappingsChanged) {
    persistVikunjaProjectMappings(baseUrl, localProjectMappings);
  }

  if (missingProjects.length > 0 && !(await confirmCreateMissingLocalProjects(host, missingProjects, baseUrl))) {
    return localProjectIdByRemoteId;
  }

  const projectsToCreate = missingProjects.filter(({ project }) =>
    !vikunjaSkippedProjectKeys.has(getVikunjaProjectSkipKey(baseUrl, project.id)),
  );
  for (const { project, title } of projectsToCreate) {
    const localProjectId = await host.addProject({ title });
    localProjectMappings.set(project.id, localProjectId);
    mappingsChanged = true;
    localProjectIdByRemoteId.set(project.id, localProjectId);
  }

  if (mappingsChanged) {
    persistVikunjaProjectMappings(baseUrl, localProjectMappings);
  }

  return localProjectIdByRemoteId;
}

async function syncLocalVikunjaProjects(
  host: VikunjaPluginHost,
  projects: VikunjaRawProject[],
  projectsById: Map<number, VikunjaRawProject>,
  prefix: string,
  baseUrl: string,
): Promise<Map<number, string>> {
  // The lock covers the local-project read, prompt, creation, and mapping
  // persistence. This prevents concurrent polling/import calls from all
  // observing the same missing project and then creating duplicates.
  return withVikunjaProjectSyncLock(baseUrl, () =>
    syncLocalVikunjaProjectsUnlocked(host, projects, projectsById, prefix, baseUrl),
  );
}

async function loadProjectSyncContext(
  client: ReturnType<typeof createVikunjaClient>,
  host: VikunjaPluginHost,
  config: Record<string, unknown>,
  includeArchivedProjects = false,
): Promise<ProjectSyncContext> {
  const projects = await client.listProjects();
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const configuredProjectIds = parseProjectIds(config);
  const selectedProjectIds = getSelectedVikunjaProjectIds(projects, configuredProjectIds);
  const selectedProjects = selectedProjectIds === undefined
    ? projects.filter((project) => includeArchivedProjects || project.is_archived !== true)
    : projects.filter((project) =>
        selectedProjectIds.has(project.id)
        && (includeArchivedProjects || project.is_archived !== true),
      );
  const prefix = parseProjectPrefix(config);

  return {
    projectTitleById: new Map(projects.map((project) => [project.id, getVikunjaProjectPath(project, projectsById)])),
    localProjectIdByRemoteId: await syncLocalVikunjaProjects(host, selectedProjects, projectsById, prefix, String(config.baseUrl ?? '')),
    archivedProjectIds: new Set(
      projects.filter((project) => project.is_archived === true).map((project) => project.id),
    ),
    selectedProjectIds,
  };
}

function getProjectSyncContextCacheKey(
  config: Record<string, unknown>,
  includeArchivedProjects: boolean,
): string {
  return JSON.stringify({
    baseUrl: normalizeVikunjaServerKey(String(config.baseUrl ?? '')),
    includeArchivedProjects,
    projectIds: parseProjectIds(config) ?? null,
    projectPrefix: parseProjectPrefix(config),
    syncProjects: isProjectSyncEnabled(config),
  });
}

function loadCachedProjectSyncContext(
  cache: Map<string, ProjectSyncContextCacheEntry>,
  client: ReturnType<typeof createVikunjaClient>,
  host: VikunjaPluginHost,
  config: Record<string, unknown>,
  includeArchivedProjects: boolean,
  refresh = false,
): Promise<ProjectSyncContext> {
  const key = getProjectSyncContextCacheKey(config, includeArchivedProjects);
  const existing = cache.get(key);
  if (existing && !refresh && existing.expiresAt > Date.now()) {
    return existing.promise;
  }

  const promise = loadProjectSyncContext(client, host, config, includeArchivedProjects);
  const entry: ProjectSyncContextCacheEntry = {
    expiresAt: Date.now() + PROJECT_SYNC_CONTEXT_CACHE_TTL_MS,
    promise,
  };
  cache.set(key, entry);

  void promise.catch(() => {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
  });

  return promise;
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

async function getVikunjaTaskSummaries(
  searchTerm: string,
  config: Record<string, unknown>,
  http: IssueProviderHttp,
  secretApi?: VikunjaPluginHost,
  options: VikunjaTaskSummaryOptions = {},
): Promise<VikunjaTaskSummary[]> {
  const projectIds = parseProjectIds(config);
  const client = createAuthenticatedClient(config, http, secretApi);
  const projectContext = isProjectSyncEnabled(config)
    ? await loadCachedProjectSyncContext(
        options.projectSyncContextCache ?? new Map(),
        client,
        getProjectSyncHost(secretApi),
        config,
        options.activeOnly !== true,
        options.refreshProjectContext === true,
      )
    : undefined;
  const archivedProjectIds = projectContext?.archivedProjectIds ?? (
    options.activeOnly
      ? new Set(
          (await client.listProjects())
            .filter((project) => project.is_archived === true)
            .map((project) => project.id),
        )
      : new Set<number>()
  );
  const tasks = await client.searchTasks(searchTerm, {
    includeSubtasks: true,
    ...(searchTerm === '' ? { perPage: 1000 } : {}),
  });
  const selectedProjectIds = projectContext?.selectedProjectIds;
  const filteredTasks = selectedProjectIds !== undefined
    ? tasks.filter((task) => task.project_id !== undefined && selectedProjectIds.has(task.project_id))
    : projectIds === undefined || projectIds.length === 0
    ? tasks
    : tasks.filter((task) => task.project_id !== undefined && projectIds.includes(task.project_id));

  const importableTasks = options.activeOnly
    ? filteredTasks.filter((task) =>
        task.done !== true
        && (task.project_id === undefined || !archivedProjectIds.has(task.project_id)),
      )
    : filteredTasks;
  const mappedTasks = importableTasks.map((task) => mapTaskWithProjectContext(task, projectContext));
  if (projectContext) {
    persistVikunjaTaskProjectMappings(
      String(config.baseUrl ?? ''),
      new Map(
        mappedTasks
          .filter((task) => typeof task.superProductivityProjectId === 'string')
          .map((task) => [task.id, task.superProductivityProjectId as string]),
      ),
    );
  }
  return mappedTasks;
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
  const pollTimestampSnapshots = new Map<string, PollTimestampSnapshot>();
  const projectSyncContextCache = new Map<string, ProjectSyncContextCacheEntry>();
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
        description: 'URL of your Vikunja server, for example https://vikunja.example. Do not append /api/v2.'
      },
      {
        key: 'projectPrefix',
        type: 'input',
        label: 'Local project prefix',
        description: `Prefix used for local Super Productivity project names. Leave blank for no prefix. Suggested prefix: ${DEFAULT_VIKUNJA_PROJECT_PREFIX}`
      },
      {
        key: 'projectIds',
        type: 'multiSelect',
        label: 'Vikunja projects to import/search',
        description: 'Choose which Vikunja projects to search and import. Selecting a parent includes all of its descendants. Leave empty for all accessible projects; automatic import still skips completed tasks and archived projects.',
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
        label: 'Preserve Vikunja project structure locally',
        description: 'Creates or updates local mirrors and assigns imported tasks to their matching project. Nested Vikunja paths appear as flat names such as Parent / Child; the plugin asks before creating missing local projects, and remote projects are never changed.'
      },
      {
        key: 'defaultProjectId',
        type: 'select',
        label: 'Default project for new tasks',
        description: 'Vikunja destination for tasks created from Super Productivity. This is the remote project, not the local Super Productivity project used for imported tasks.',
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
      return getVikunjaTaskSummaries(searchTerm, config, http, secretApi, {
        projectSyncContextCache,
        refreshProjectContext: true,
      });
    },
    async getNewIssuesForBacklog(config, http: IssueProviderHttp) {
      return getVikunjaTaskSummaries('', config, http, secretApi, {
        activeOnly: true,
        projectSyncContextCache,
        refreshProjectContext: true,
      });
    },
    async getById(issueId, config, http: IssueProviderHttp) {
      const taskId = parseCanonicalTaskId(issueId);

      const client = createAuthenticatedClient(config, http, secretApi);
      const task = await client.getTaskById(taskId, { includeSubtasks: true });
      const projectContext = isProjectSyncEnabled(config)
        ? await loadCachedProjectSyncContext(
            projectSyncContextCache,
            client,
            getProjectSyncHost(secretApi),
            config,
            true,
          )
        : undefined;

      const issue = mapTaskDetailsWithProjectContext(task, projectContext);
      const hostComparableLastUpdated = getHostComparableLastUpdated(
        issue.id,
        String(config.baseUrl ?? ''),
        issue.lastUpdated,
        pollTimestampSnapshots,
      );

      return hostComparableLastUpdated === issue.lastUpdated
        ? issue
        : { ...issue, lastUpdated: hostComparableLastUpdated };
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
      const vikunjaProjectId = typeof issue.projectId === 'string'
        && /^[1-9]\d*$/.test(issue.projectId)
        ? issue.projectId
        : undefined;
      const superProductivityProjectId = typeof issue.superProductivityProjectId === 'string'
        && issue.superProductivityProjectId
        ? issue.superProductivityProjectId
        : undefined;

      return {
        ...(superProductivityProjectId ? { superProductivityProjectId } : {}),
        ...(vikunjaProjectId ? { vikunjaProjectId } : {}),
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
  registerVikunjaTokenAccess(api);
  registerVikunjaProjectAssignmentHook(api);
}

const VIKUNJA_TOKEN_INPUT_ID = 'vikunja-plugin-api-token-input';

async function saveVikunjaTokenFromDialog(api: VikunjaPluginHost): Promise<void> {
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
    ico: 'key'
  });
}

let repairVikunjaProjects: (() => Promise<number>) | undefined;

function createVikunjaTokenDialog(
  api: VikunjaPluginHost,
  tokenConfigured: boolean,
): PluginDialogConfig {
  const tokenStatus = tokenConfigured
    ? 'Configured on this computer.'
    : 'Not configured on this computer.';
  const repair = repairVikunjaProjects;

  return {
    htmlContent: `
      <label for="${VIKUNJA_TOKEN_INPUT_ID}">Vikunja API token</label>
      <input id="${VIKUNJA_TOKEN_INPUT_ID}" type="password" autocomplete="off" spellcheck="false" />
      <p><strong>Token status:</strong> ${tokenStatus}</p>
      <p>Stored locally in Super Productivity secret storage; it is not part of provider configuration or sync data.</p>
    `,
    buttons: [
      {
        label: tokenConfigured ? 'Replace token' : 'Save token',
        icon: 'key',
        onClick: () => saveVikunjaTokenFromDialog(api)
      },
      ...(repair ? [
        {
          label: 'Repair Vikunja projects',
          icon: 'account_tree',
          onClick: async () => {
            try {
              const movedCount = await repair();
              api.showSnack?.({
                msg: movedCount > 0
                  ? `Moved ${movedCount} imported Vikunja task${movedCount === 1 ? '' : 's'} to the matching projects.`
                  : 'No imported Vikunja tasks need project repair.',
                type: 'SUCCESS',
                ico: 'account_tree'
              });
            } catch {
              api.showSnack?.({
                msg: 'Could not repair imported Vikunja projects. Try again after Super Productivity finishes loading.',
                type: 'ERROR',
                ico: 'warning'
              });
            }
          }
        },
        {
          label: 'Reset Vikunja project prompt decisions',
          icon: 'refresh',
          onClick: () => {
            vikunjaSkippedProjectKeys.clear();
            persistSkippedVikunjaProjectKeys(vikunjaSkippedProjectKeys);
            api.showSnack?.({
              msg: 'Vikunja project prompt decisions were reset. Run a search or import again to review missing projects.',
              type: 'INFO',
              ico: 'refresh'
            });
          }
        }
      ] : [])
    ]
  };
}

async function openVikunjaTokenDialog(api: VikunjaPluginHost): Promise<void> {
  if (!api.openDialog) {
    return;
  }

  if (!vikunjaTokenDialogPromise) {
    vikunjaTokenDialogPromise = (async () => {
      const token = await getVikunjaApiToken(api);
      await api.openDialog?.(createVikunjaTokenDialog(api, Boolean(token?.trim())));
    })().finally(() => {
      vikunjaTokenDialogPromise = null;
    });
  }

  await vikunjaTokenDialogPromise;
}

function registerVikunjaTokenAccess(api: PluginAPI): void {
  if (!api.openDialog) {
    return;
  }

  const openTokenDialog = () => {
    void openVikunjaTokenDialog(api);
  };

  // Super Productivity renders this handler as the settings action on the
  // plugin card. Keep connection setup out of the persistent main top bar.
  api.registerConfigHandler?.(openTokenDialog);
}


const VIKUNJA_PLUGIN_ID = 'vikunja-super-productivity-plugin';
const VIKUNJA_ISSUE_TYPE = `plugin:${VIKUNJA_PLUGIN_ID}`;
const VIKUNJA_SKIPPED_PROJECTS_STORAGE_KEY = `${VIKUNJA_PLUGIN_ID}.skipped-local-projects`;
const VIKUNJA_PROJECT_MAPPINGS_STORAGE_KEY = `${VIKUNJA_PLUGIN_ID}.local-project-mappings`;
const VIKUNJA_TASK_PROJECT_MAPPINGS_STORAGE_KEY = `${VIKUNJA_PLUGIN_ID}.task-project-mappings`;
const vikunjaTaskProjectMappings = new Map<string, string>();
const vikunjaSkippedProjectKeys = new Set(loadSkippedVikunjaProjectKeys());

function isVikunjaIssueType(value: unknown): boolean {
  return value === VIKUNJA_ISSUE_TYPE || value === VIKUNJA_PLUGIN_ID;
}

interface LocalTaskHierarchyRecord {
  id: string;
  projectId?: string | null;
  parentId?: string | null;
  subTaskIds?: string[];
  issueId?: string | null;
  issueProviderId?: string | null;
  issueType?: string | null;
}

function isCanonicalRemoteTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isLocalTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isVikunjaLinkedTask(task: LocalTaskHierarchyRecord): boolean {
  return isCanonicalRemoteTaskId(task.issueId)
    && (task.issueType === VIKUNJA_ISSUE_TYPE
      || task.issueProviderId === undefined
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

  // PluginAPI methods are class methods in Super Productivity. Preserve the
  // API receiver when the methods are used by asynchronous hook callbacks;
  // otherwise the host rejects the call even after its data has loaded.
  const updateTask = api.updateTask.bind(api);
  const batchUpdateForProject = api.batchUpdateForProject?.bind(api);
  const updatingTaskIds = new Set<string>();

  const withUpdatingTaskIds = async <T>(
    taskIds: string[],
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    const ids = [...new Set(taskIds)].filter((taskId) => !updatingTaskIds.has(taskId));
    if (ids.length === 0) {
      return undefined;
    }

    for (const taskId of ids) {
      updatingTaskIds.add(taskId);
    }
    try {
      return await operation();
    } finally {
      for (const taskId of ids) {
        updatingTaskIds.delete(taskId);
      }
    }
  };

  const applyLocalProjectUpdate = async (
    taskId: string,
    projectId: string,
  ): Promise<void> => {
    await withUpdatingTaskIds([taskId], () => updateTask(taskId, { projectId }));
  };

  const addRelationOperation = (
    operations: Map<string, PluginBatchTaskUpdate['updates']>,
    taskId: string,
    updates: PluginBatchTaskUpdate['updates'],
  ): void => {
    const existing = operations.get(taskId) ?? {};
    const merged: PluginBatchTaskUpdate['updates'] = { ...existing, ...updates };
    if (existing.subTaskIds || updates.subTaskIds) {
      merged.subTaskIds = [...new Set([...(existing.subTaskIds ?? []), ...(updates.subTaskIds ?? [])])];
    }
    operations.set(taskId, merged);
  };

  const addParentChildOperations = (
    operations: Map<string, PluginBatchTaskUpdate['updates']>,
    linkedTasks: LocalTaskHierarchyRecord[],
    parent: LocalTaskHierarchyRecord,
    child: LocalTaskHierarchyRecord,
  ): void => {
    if (
      parent.id === child.id
      || !isLocalTaskId(parent.id)
      || !isLocalTaskId(child.id)
      || wouldCreateLocalTaskCycle(linkedTasks, child.id, parent.id)
    ) {
      return;
    }

    const nextSubTaskIds = [...new Set([...(parent.subTaskIds ?? []), child.id])];
    if (nextSubTaskIds.length !== (parent.subTaskIds ?? []).length) {
      addRelationOperation(operations, parent.id, { subTaskIds: nextSubTaskIds });
    }
    if (child.parentId !== parent.id) {
      addRelationOperation(operations, child.id, { parentId: parent.id });
    }
  };

  const applyLocalHierarchyUpdates = async (
    projectId: string | undefined,
    operations: Map<string, PluginBatchTaskUpdate['updates']>,
  ): Promise<void> => {
    if (!batchUpdateForProject || !projectId || operations.size === 0) {
      return;
    }

    const batchOperations: PluginBatchTaskUpdate[] = [...operations].map(([taskId, updates]) => ({
      type: 'update',
      taskId,
      updates,
    }));

    // Re-parenting is intentionally routed through the host batch API. The
    // regular updateTask API rejects parentId/subTaskIds and would also make a
    // combined project+parent update lose the project move.
    await withUpdatingTaskIds(
      batchOperations.map(({ taskId }) => taskId),
      async () => {
        try {
          await batchUpdateForProject({ projectId, operations: batchOperations });
        } catch {
          // Local hierarchy repair is best-effort. Project placement and the
          // remote issue synchronization must continue if an older host or a
          // transient local batch failure rejects this optional operation.
        }
      },
    );
  };


  const handleTaskHook = async (
    payload: unknown,
    includeRelations = true,
    useStoredProjectMapping = false,
  ): Promise<void> => {
    if (!isRecord(payload)) {
      return;
    }

    const taskData = isRecord(payload.task) ? payload.task : payload;
    const taskId = typeof payload.taskId === 'string'
      ? payload.taskId
      : taskData.id;
    const syncValues = isRecord(taskData.issueLastSyncedValues)
      ? taskData.issueLastSyncedValues
      : undefined;
    const issueProviderId = taskData.issueProviderId;
    const issueType = taskData.issueType;
    if (
      typeof taskId !== 'string'
      || (
        issueProviderId !== undefined
        && issueProviderId !== null
        && issueProviderId !== VIKUNJA_PLUGIN_ID
        && !isVikunjaIssueType(issueType)
      )
      || updatingTaskIds.has(taskId)
    ) {
      return;
    }

    const effectiveSyncValues = syncValues ?? {};
    const remoteProjectId = typeof effectiveSyncValues.vikunjaProjectId === 'string'
      && isCanonicalRemoteTaskId(effectiveSyncValues.vikunjaProjectId)
      ? effectiveSyncValues.vikunjaProjectId
      : undefined;
    const storedProjectId = useStoredProjectMapping && isCanonicalRemoteTaskId(taskData.issueId)
      ? getStoredVikunjaTaskProjectId(taskData.issueId)
      : undefined;
    const mappedRemoteProjectId = useStoredProjectMapping && remoteProjectId
      ? getStoredVikunjaLocalProjectId(remoteProjectId)
      : undefined;

    if (!syncValues && !storedProjectId && !mappedRemoteProjectId) {
      return;
    }

    const mappedProjectId = typeof effectiveSyncValues.superProductivityProjectId === 'string'
      ? effectiveSyncValues.superProductivityProjectId
      : storedProjectId ?? mappedRemoteProjectId;
    const currentTask: LocalTaskHierarchyRecord = {
      id: taskId,
      projectId: typeof taskData.projectId === 'string' ? taskData.projectId : null,
      parentId: typeof taskData.parentId === 'string' ? taskData.parentId : null,
      subTaskIds: Array.isArray(taskData.subTaskIds)
        ? taskData.subTaskIds.filter((id): id is string => typeof id === 'string')
        : [],
      issueId: typeof taskData.issueId === 'string' ? taskData.issueId : undefined,
      issueProviderId: typeof taskData.issueProviderId === 'string' ? taskData.issueProviderId : undefined,
      issueType: typeof taskData.issueType === 'string' ? taskData.issueType : undefined,
    };

    if (mappedProjectId !== undefined && currentTask.projectId !== mappedProjectId) {
      await applyLocalProjectUpdate(taskId, mappedProjectId);
      currentTask.projectId = mappedProjectId;
    }

    let linkedTasks: LocalTaskHierarchyRecord[] = [];
    if (includeRelations && effectiveSyncValues.vikunjaRelationsLoaded === true && api.getTasks) {
      try {
        linkedTasks = await api.getTasks();
      } catch {
        linkedTasks = [];
      }
    }

    const linkedTaskById = new Map(linkedTasks.map((task) => [task.id, task]));
    linkedTaskById.set(taskId, currentTask);
    const hierarchyTasks = [...linkedTaskById.values()];

    const linkedTaskByRemoteId = new Map<string, LocalTaskHierarchyRecord>();
    for (const task of hierarchyTasks) {
      if (isVikunjaLinkedTask(task)) {
        linkedTaskByRemoteId.set(task.issueId as string, task);
      }
    }

    const hierarchyOperations = new Map<string, PluginBatchTaskUpdate['updates']>();
    if (includeRelations && effectiveSyncValues.vikunjaRelationsLoaded === true) {
      const parentRemoteId = effectiveSyncValues.vikunjaParentTaskAmbiguous === true
        ? undefined
        : isCanonicalRemoteTaskId(effectiveSyncValues.vikunjaParentTaskId)
          ? effectiveSyncValues.vikunjaParentTaskId
          : undefined;
      const localParent = parentRemoteId ? linkedTaskByRemoteId.get(parentRemoteId) : undefined;

      if (localParent) {
        addParentChildOperations(hierarchyOperations, hierarchyTasks, localParent, currentTask);
      }

      const childRemoteIds = Array.isArray(effectiveSyncValues.vikunjaSubtaskTaskIds)
        ? effectiveSyncValues.vikunjaSubtaskTaskIds.filter(isCanonicalRemoteTaskId)
        : [];

      for (const childRemoteId of childRemoteIds) {
        const localChild = linkedTaskByRemoteId.get(childRemoteId);
        if (localChild) {
          addParentChildOperations(hierarchyOperations, hierarchyTasks, currentTask, localChild);
        }
      }

      const hierarchyProjectId = localParent?.projectId
        ?? currentTask.projectId
        ?? linkedTaskById.get(taskId)?.projectId;
      await applyLocalHierarchyUpdates(hierarchyProjectId ?? undefined, hierarchyOperations);
    }
  };

  // Native issue imports first place a new task in the provider's configured
  // default project. Repair that placement after the host has created the
  // task, using the project ID captured in issueLastSyncedValues.
  api.registerHook('taskCreated', (payload) => handleTaskHook(payload, true, true));
  api.registerHook('taskUpdate', (payload) => handleTaskHook(payload, true, true));

  const reconcileExistingTaskProjects = async (): Promise<number> => {
    lastReconciledTaskCount = 0;
    if (!api.getTasks) {
      return 0;
    }

    const tasks = await api.getTasks();
    lastReconciledTaskCount = tasks.length;
    let movedCount = 0;
    for (const task of tasks) {
      const syncValues = isRecord(task.issueLastSyncedValues)
        ? task.issueLastSyncedValues
        : undefined;
      const storedProjectId = isVikunjaIssueType(task.issueType)
        && isCanonicalRemoteTaskId(task.issueId)
        ? getStoredVikunjaTaskProjectId(task.issueId)
        : undefined;
      const remoteProjectId = typeof syncValues?.vikunjaProjectId === 'string'
        && isCanonicalRemoteTaskId(syncValues.vikunjaProjectId)
        ? syncValues.vikunjaProjectId
        : undefined;
      const mappedRemoteProjectId = remoteProjectId
        ? getStoredVikunjaLocalProjectId(remoteProjectId)
        : undefined;
      const targetProjectId = typeof syncValues?.superProductivityProjectId === 'string'
        ? syncValues.superProductivityProjectId
        : storedProjectId ?? mappedRemoteProjectId;
      if (
        targetProjectId !== undefined
        && task.projectId !== targetProjectId
      ) {
        movedCount += 1;
      }
      await handleTaskHook(task, false, true);
    }
    return movedCount;
  };
  repairVikunjaProjects = reconcileExistingTaskProjects;

  let lastReconciledTaskCount = 0;
  const startupRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  const startupRetryDelays = [1000, 3000, 7000];
  const scheduleStartupRepairRetry = (attempt = 0): void => {
    const delay = startupRetryDelays[attempt];
    if (delay === undefined) {
      return;
    }

    const timer = setTimeout(() => {
      startupRetryTimers.delete(timer);
      void reconcileExistingTaskProjects()
        .then(() => {
          if (lastReconciledTaskCount === 0) {
            scheduleStartupRepairRetry(attempt + 1);
          }
        })
        .catch(() => {
          scheduleStartupRepairRetry(attempt + 1);
        });
    }, delay);
    startupRetryTimers.add(timer);
  };
  api.onUnload?.(() => {
    for (const timer of startupRetryTimers) {
      clearTimeout(timer);
    }
    startupRetryTimers.clear();
    repairVikunjaProjects = undefined;
  });

  const runStartupRepair = (): void => {
    if (!api.getTasks) {
      return;
    }
    void reconcileExistingTaskProjects()
      .then(() => {
        // Super Productivity 18.19 does not expose onReady. Retry only when
        // that older host returned an empty task store during plugin startup.
        if (!api.onReady && lastReconciledTaskCount === 0) {
          scheduleStartupRepairRetry();
        }
      })
      .catch(() => {
        if (!api.onReady) {
          scheduleStartupRepairRetry();
      }
    });
  };

  const runStartupInitialization = async (): Promise<void> => {
    // Super Productivity's issue polling effect starts from the host's data
    // initialization action. A plugin can register after that action has
    // already fired, leaving the provider's background timer unarmed until
    // the user saves the provider settings again. Newer hosts expose this
    // supported replay hook; use it once after registration so the normal
    // host polling path can see Vikunja. Older hosts simply skip this step.
    // This workaround can be removed after the host-side polling registration
    // fix for #10112/#10165 is released.
    if (api.reInitData) {
      try {
        await api.reInitData();
      } catch {
        // Reinitialization is only a polling bootstrap mitigation. Do not
        // prevent the plugin's existing startup repair from running if an
        // older or partially initialized host rejects the request.
      }
    }

    runStartupRepair();
  };

  // Also repair tasks imported by an older plugin build. getTasks() returns
  // active tasks, including completed ones that have not been archived.
  if (api.onReady) {
    api.onReady(runStartupInitialization);
  } else {
    runStartupRepair();
  }

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
