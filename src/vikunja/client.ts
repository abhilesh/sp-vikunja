import type {
  IssueProviderHttp,
  IssueProviderHttpOptions,
  VikunjaConnectionConfig,
  VikunjaHeaderProvider,
  VikunjaPaginatedEnvelope,
  VikunjaTaskUpdatePatch,
  VikunjaTaskCreatePayload,
  VikunjaRawProject,
  VikunjaRawTask,
  VikunjaRawRelatedTask,
  VikunjaRawRelatedTaskMap,
  VikunjaLogSink
} from './types.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 1000;

export interface VikunjaClientPaginationOptions {
  page?: number;
  perPage?: number;
  includeSubtasks?: boolean;
}

export interface VikunjaTaskReadOptions {
  includeSubtasks?: boolean;
}

export interface CreateVikunjaClientOptions extends VikunjaConnectionConfig {
  http: IssueProviderHttp;
  getHeaders: VikunjaHeaderProvider;
  logger?: VikunjaLogSink;
}

export interface VikunjaClient {
  readonly baseUrl: string;
  readonly taskListUrl: string;
  readonly projectListUrl: string;
  searchTasks(searchTerm: string, options?: VikunjaClientPaginationOptions): Promise<VikunjaRawTask[]>;
  getTaskById(taskId: number, options?: VikunjaTaskReadOptions): Promise<VikunjaRawTask>;
  updateTask(taskId: number, patch: VikunjaTaskUpdatePatch): Promise<void>;
  createTask(projectId: number, payload: VikunjaTaskCreatePayload): Promise<VikunjaRawTask>;
  listProjects(options?: VikunjaClientPaginationOptions): Promise<VikunjaRawProject[]>;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new Error('Vikunja base URL is required.');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmedBaseUrl);
  } catch {
    throw new Error('Vikunja base URL must be a valid http or https URL.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Vikunja base URL must use http or https.');
  }

  return parsedUrl.toString().replace(/\/+$/, '');
}

export function buildTaskFrontendUrl(baseUrl: string, taskId: number): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return toEndpointUrl(normalizedBaseUrl, `tasks/${encodeURIComponent(String(taskId))}`);
}

function toEndpointUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString().replace(/\/+$/, '');
}

function buildRequestUrl(url: string, params: Record<string, string>): string {
  const requestUrl = new URL(url);

  for (const [key, value] of Object.entries(params)) {
    requestUrl.searchParams.set(key, value);
  }

  return requestUrl.toString();
}

function parsePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`Vikunja ${label} must be an integer greater than or equal to 1.`);
  }

  return resolved;
}

function parsePerPage(value: number | undefined): number {
  const resolved = parsePositiveInteger(value, DEFAULT_PER_PAGE, 'per_page');

  if (resolved > MAX_PER_PAGE) {
    throw new Error(`Vikunja per_page must be between 1 and ${MAX_PER_PAGE}.`);
  }

  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function assertPaginatedInteger(
  value: unknown,
  label: string,
  min: number,
  max?: number,
): number {
  if (!isNumber(value) || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    if (max !== undefined) {
      throw new Error(`Invalid Vikunja paginated response envelope: ${label} must be an integer between ${min} and ${max}.`);
    }

    throw new Error(`Invalid Vikunja paginated response envelope: ${label} must be an integer greater than or equal to ${min}.`);
  }

  return value;
}

function decodePaginatedEnvelope<TItem>(
  value: unknown,
  itemGuard: (item: unknown) => item is TItem,
  errorLabel: string,
): VikunjaPaginatedEnvelope<TItem> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(`Invalid Vikunja ${errorLabel} response envelope.`);
  }

  const page = assertPaginatedInteger(value.page, 'page', 1);
  const perPage = assertPaginatedInteger(value.per_page, 'per_page', 1, MAX_PER_PAGE);
  const total = assertPaginatedInteger(value.total, 'total', 0);
  const totalPages = assertPaginatedInteger(value.total_pages, 'total_pages', 0);

  const items = value.items.filter(itemGuard);

  if (items.length !== value.items.length) {
    throw new Error(`Invalid Vikunja ${errorLabel} response envelope.`);
  }

  return {
    items,
    page,
    per_page: perPage,
    total,
    total_pages: totalPages
  };
}

function isRawLabel(value: unknown): value is { id: number; title: string } {
  return isRecord(value) && isNumber(value.id) && isString(value.title);
}
function isRawRelatedTask(value: unknown): value is VikunjaRawRelatedTask {
  return (
    isRecord(value)
    && isNumber(value.id)
    && Number.isInteger(value.id)
    && value.id > 0
    && isString(value.title)
    && (value.project_id === undefined || isNumber(value.project_id))
  );
}

function isRawRelatedTaskMap(value: unknown): value is VikunjaRawRelatedTaskMap {
  return isRecord(value) && Object.values(value).every((relatedTasks) => (
    relatedTasks === null
    || (Array.isArray(relatedTasks) && relatedTasks.every(isRawRelatedTask))
  ));
}

function isRawTask(value: unknown): value is VikunjaRawTask {
  return (
    isRecord(value)
    && isNumber(value.id)
    && isString(value.title)
    && (value.description === undefined || isString(value.description))
    && (value.done === undefined || typeof value.done === 'boolean')
    && (value.project_id === undefined || isNumber(value.project_id))
    && (value.priority === undefined || isNumber(value.priority))
    && (value.due_date === undefined || isString(value.due_date))
    && (value.updated === undefined || isString(value.updated))
    && (
      value.labels === undefined
      || value.labels === null
      || (Array.isArray(value.labels) && value.labels.every(isRawLabel))
    )
    && (value.related_tasks === undefined || value.related_tasks === null || isRawRelatedTaskMap(value.related_tasks))
  );
}

function isRawProject(value: unknown): value is VikunjaRawProject {
  return (
    isRecord(value)
    && isNumber(value.id)
    && isString(value.title)
    && (value.parent_project_id === undefined || value.parent_project_id === null || isNumber(value.parent_project_id))
    && (value.is_archived === undefined || typeof value.is_archived === 'boolean')
  );
}

function getHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const candidate = error.status ?? error.statusCode ?? (isRecord(error.response) ? error.response.status : undefined);

  return isNumber(candidate) ? candidate : undefined;
}

function isNetworkFailure(error: unknown): boolean {
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

function sanitizeClientError(operation: string, error: unknown): Error {
  const status = getHttpStatus(error);
  const suffix = status ? ` (${status})` : '';
  const sanitized = new Error(`Vikunja API request failed during ${operation}${suffix}.`);

  if (status !== undefined) {
    Object.assign(sanitized, { status });
  }

  if (isNetworkFailure(error)) {
    Object.assign(sanitized, { networkFailure: true });
  }

  return sanitized;
}

async function runGetRequest<TResponse>(
  http: IssueProviderHttp,
  getHeaders: VikunjaHeaderProvider,
  url: string,
  params: Record<string, string> | undefined,
  operation: string,
  logger?: VikunjaLogSink,
): Promise<TResponse> {
  logger?.({ event: 'request', operation });
  const headers = await getHeaders();
  const options: IssueProviderHttpOptions = {
    headers,
    responseType: 'json'
  };

  if (params) {
    options.params = params;
  }

  try {
    return await http.get<TResponse>(url, options);
  } catch (error) {
    const status = getHttpStatus(error);
    logger?.({ event: 'request-failure', operation, ...(status === undefined ? {} : { status }) });
    throw sanitizeClientError(operation, error);
  }
}

async function runPatchRequest(
  http: IssueProviderHttp,
  getHeaders: VikunjaHeaderProvider,
  url: string,
  body: VikunjaTaskUpdatePatch,
  operation: string,
  logger?: VikunjaLogSink,
): Promise<void> {
  logger?.({ event: 'request', operation });
  const headers = await getHeaders();

  try {
    await http.patch(url, body, {
      headers: {
        ...headers,
        'Content-Type': 'application/merge-patch+json'
      },
      responseType: 'json'
    });
  } catch (error) {
    const status = getHttpStatus(error);
    logger?.({ event: 'request-failure', operation, ...(status === undefined ? {} : { status }) });
    throw sanitizeClientError(operation, error);
  }
}

async function runPostRequest<TResponse>(
  http: IssueProviderHttp,
  getHeaders: VikunjaHeaderProvider,
  url: string,
  body: VikunjaTaskCreatePayload,
  operation: string,
  logger?: VikunjaLogSink,
): Promise<TResponse> {
  logger?.({ event: 'request', operation });
  const headers = await getHeaders();

  try {
    return await http.post<TResponse>(url, body, {
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      responseType: 'json'
    });
  } catch (error) {
    const status = getHttpStatus(error);
    logger?.({ event: 'request-failure', operation, ...(status === undefined ? {} : { status }) });
    throw sanitizeClientError(operation, error);
  }
}

async function collectPages<TItem>(
  http: IssueProviderHttp,
  getHeaders: VikunjaHeaderProvider,
  startPage: number,
  buildRequest: (currentPage: number) => { url: string; params?: Record<string, string> },
  itemGuard: (item: unknown) => item is TItem,
  errorLabel: string,
  operation: string,
  logger?: VikunjaLogSink,
): Promise<TItem[]> {
  const aggregated: TItem[] = [];
  let currentPage = startPage;
  let totalPages = 1;

  while (currentPage <= totalPages) {
    const request = buildRequest(currentPage);
    const response = await runGetRequest<unknown>(
      http,
      getHeaders,
      request.url,
      request.params,
      operation,
      logger,
    );
    const envelope = decodePaginatedEnvelope(response, itemGuard, errorLabel);

    aggregated.push(...envelope.items);
    totalPages = envelope.total_pages;

    if (totalPages === 0) {
      break;
    }

    currentPage += 1;
  }

  return aggregated;
}

function decodeTask(value: unknown, errorLabel: string): VikunjaRawTask {
  if (!isRawTask(value)) {
    throw new Error(`Invalid Vikunja ${errorLabel} response body.`);
  }

  return value;
}

export function createVikunjaClient(options: CreateVikunjaClientOptions): VikunjaClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const taskListUrl = toEndpointUrl(baseUrl, 'api/v2/tasks');
  const projectListUrl = toEndpointUrl(baseUrl, 'api/v2/projects');

  return {
    baseUrl,
    taskListUrl,
    projectListUrl,
    async searchTasks(searchTerm, pagination) {
      const page = parsePositiveInteger(pagination?.page, DEFAULT_PAGE, 'page');
      const perPage = parsePerPage(pagination?.perPage);

      return collectPages(
        options.http,
        options.getHeaders,
        page,
        (currentPage) => {
          const params: Record<string, string> = {
            q: searchTerm,
            page: String(currentPage),
            per_page: String(perPage),
            format: 'markdown'
          };

          if (pagination?.includeSubtasks) {
            params.expand = 'subtasks';
          }

          return { url: buildRequestUrl(taskListUrl, params) };
        },
        isRawTask,
        'task list',
        'task search',
        options.logger,
      );
    },
    async getTaskById(taskId, readOptions) {
      const parsedTaskId = parsePositiveInteger(taskId, taskId, 'task ID');
      const response = await runGetRequest<unknown>(
        options.http,
        options.getHeaders,
        `${taskListUrl}/${encodeURIComponent(String(parsedTaskId))}`,
        { format: 'markdown', ...(readOptions?.includeSubtasks ? { expand: 'subtasks' } : {}) },
        'task fetch',
        options.logger,
      );

      return decodeTask(response, 'task');
    },
    async updateTask(taskId, patch) {
      const parsedTaskId = parsePositiveInteger(taskId, taskId, 'task ID');

      await runPatchRequest(
        options.http,
        options.getHeaders,
        `${taskListUrl}/${encodeURIComponent(String(parsedTaskId))}`,
        patch,
        'task update',
        options.logger,
      );
    },
    async createTask(projectId, payload) {
      const parsedProjectId = parsePositiveInteger(projectId, projectId, 'project ID');
      const response = await runPostRequest<unknown>(
        options.http,
        options.getHeaders,
        buildRequestUrl(toEndpointUrl(baseUrl, `api/v2/projects/${encodeURIComponent(String(parsedProjectId))}/tasks`), {
          format: 'markdown'
        }),
        payload,
        'task create',
        options.logger,
      );

      return decodeTask(response, 'created task');
    },
    async listProjects(pagination) {
      const page = parsePositiveInteger(pagination?.page, DEFAULT_PAGE, 'page');
      const perPage = parsePerPage(pagination?.perPage);

      return collectPages(
        options.http,
        options.getHeaders,
        page,
        (currentPage) => ({
          url: projectListUrl,
          params: {
            page: String(currentPage),
            per_page: String(perPage)
          }
        }),
        isRawProject,
        'project list',
        'project list',
        options.logger,
      );
    }
  };
}
