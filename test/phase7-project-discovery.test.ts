import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import type { IssueProviderHttp, IssueProviderHttpOptions } from '../src/vikunja/types.js';

function createHttpStub() {
  const http: IssueProviderHttp = {
    get: vi.fn() as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };

  return http;
}

function projectEnvelope(items: unknown[]) {
  return { items, page: 1, per_page: 50, total: items.length, total_pages: 1 };
}

function taskEnvelope(items: unknown[]) {
  return { items, page: 1, per_page: 50, total: items.length, total_pages: 1 };
}

it('exposes dynamic project options with ID-disambiguated names and no archived projects', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockResolvedValue(projectEnvelope([
    { id: 2, title: 'Research', is_archived: false },
    { id: 7, title: 'Research', is_archived: false },
    { id: 8, title: 'Old', is_archived: true },
  ]));
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);
  const projectField = definition.configFields.find((field) => field.key === 'projectIds');

  await expect(projectField?.loadOptions?.({ baseUrl: 'https://vikunja.example/' }, http)).resolves.toEqual([
    { label: 'Research (ID 2)', value: '2' },
    { label: 'Research (ID 7)', value: '7' },
  ]);
});

it('filters search results by configured project IDs, not project names', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockResolvedValue(taskEnvelope([
    { id: 1, title: 'One', project_id: 2, done: false },
    { id: 2, title: 'Two', project_id: 7, done: false },
    { id: 3, title: 'Three', project_id: 2, done: true },
  ]));
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.searchIssues('task', { baseUrl: 'https://vikunja.example/', projectIds: ['2'] }, http),
  ).resolves.toMatchObject([
    { id: '1', title: 'One' },
    { id: '3', title: 'Three' },
  ]);
});

it('searches all projects when no project filter is configured', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockResolvedValue(taskEnvelope([
    { id: 1, title: 'One', project_id: 2, done: false },
    { id: 2, title: 'Two', project_id: 7, done: false },
  ]));
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.searchIssues('task', { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toHaveLength(2);
});

it('rejects malformed project filters before making a task request', async () => {
  const http = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.searchIssues('task', { baseUrl: 'https://vikunja.example/', projectIds: ['bad'] }, http),
  ).rejects.toThrowError(/project IDs/i);
  expect(http.get).not.toHaveBeenCalled();
});

it('mirrors selected Vikunja projects locally and attaches imported tasks to them', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([
        { id: 2, title: 'Research', is_archived: false },
        { id: 7, title: 'Archived', is_archived: true },
      ]);
    }

    return taskEnvelope([
      { id: 42, title: 'Imported task', project_id: 2, done: false },
    ]);
  });
  const addedProjects: Array<{ title: string }> = [];
  const host = {
    getSecret: vi.fn(async () => 'synthetic-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    getAllProjects: vi.fn(async () => []),
    addProject: vi.fn(async (projectData: { title: string }) => {
      addedProjects.push(projectData);
      return 'local-research';
    }),
    updateProject: vi.fn(async () => undefined),
  };
  const definition = buildVikunjaIssueProviderDefinition(host);

  await expect(
    definition.searchIssues('imported', {
      baseUrl: 'https://vikunja.example/',
      projectIds: ['2'],
      syncProjects: true,
    }, http),
  ).resolves.toMatchObject([
    {
      id: '42',
      projectId: '2',
      projectTitle: 'Research',
      superProductivityProjectId: 'local-research',
    },
  ]);
  expect(addedProjects).toEqual([{ title: 'Vikunja · Research [2]' }]);
  expect(host.getAllProjects).toHaveBeenCalledOnce();
});

it('renames an existing local mirror when a Vikunja project is renamed', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([{ id: 2, title: 'Research', is_archived: false }]);
    }

    return taskEnvelope([{ id: 42, title: 'Imported task', project_id: 2, done: false }]);
  });
  const updateProject = vi.fn(async () => undefined);
  const host = {
    getSecret: vi.fn(async () => 'synthetic-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    getAllProjects: vi.fn(async () => [{ id: 'local-research', title: 'Vikunja · Old name [2]' }]),
    addProject: vi.fn(async () => 'unexpected-new-project'),
    updateProject,
  };
  const definition = buildVikunjaIssueProviderDefinition(host);

  await definition.searchIssues('imported', {
    baseUrl: 'https://vikunja.example/',
    syncProjects: true,
  }, http);

  expect(host.addProject).not.toHaveBeenCalled();
  expect(updateProject).toHaveBeenCalledWith('local-research', { title: 'Vikunja · Research [2]' });
});

it('maps the local project field as pull-only task metadata', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);
  const mapping = definition.fieldMappings?.find((entry) => entry.taskField === 'projectId');

  expect(mapping).toMatchObject({
    taskField: 'projectId',
    issueField: 'superProductivityProjectId',
    defaultDirection: 'pullOnly',
  });
  expect(mapping?.toTaskValue('local-research', { issueId: '42' })).toBe('local-research');
  expect(mapping?.toIssueValue('local-research', { issueId: '42' })).toBe('local-research');
});
