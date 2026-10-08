import { expect, it, vi } from 'vitest';
import type { PluginDialogConfig } from '../src/vikunja/types.js';

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
    { id: 2, title: 'Research', parent_project_id: null, is_archived: false },
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

it('exposes all matching tasks to the native backlog importer', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockResolvedValue(taskEnvelope([
    { id: 1, title: 'One', project_id: 2, done: false },
    { id: 2, title: 'Two', project_id: 7, done: true },
  ]));
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.getNewIssuesForBacklog?.({
      baseUrl: 'https://vikunja.example/',
      projectIds: ['2'],
    }, http),
  ).resolves.toMatchObject([{ id: '1', title: 'One' }]);

  expect(http.get).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/tasks?q=&page=1&per_page=1000&format=markdown&expand=subtasks',
    expect.objectContaining({
      headers: { Authorization: 'Bearer synthetic-token' },
    }),
  );
});

it('skips completed tasks and archived projects during automatic import', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([
        { id: 2, title: 'Active', is_archived: false },
        { id: 8, title: 'Archived', is_archived: true },
      ]);
    }

    return taskEnvelope([
      { id: 1, title: 'Open task', project_id: 2, done: false },
      { id: 2, title: 'Completed task', project_id: 2, done: true },
      { id: 3, title: 'Archived-project task', project_id: 8, done: false },
      { id: 4, title: 'Other open task', project_id: 9, done: false },
    ]);
  });
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.getNewIssuesForBacklog?.({ baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toMatchObject([
    { id: '1', title: 'Open task' },
    { id: '4', title: 'Other open task' },
  ]);
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
  expect(addedProjects).toEqual([{ title: 'Research' }]);
  expect(host.getAllProjects).toHaveBeenCalledOnce();
});
it('prompts before creating missing local project mirrors', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([{ id: 2, title: 'Research', is_archived: false }]);
    }

    return taskEnvelope([{ id: 42, title: 'Imported task', project_id: 2, done: false }]);
  });
  const addedProjects: Array<{ title: string }> = [];
  const dialogs: PluginDialogConfig[] = [];
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
    openDialog: vi.fn(async (config: PluginDialogConfig) => {
      dialogs.push(config);
      await config.buttons?.[0]?.onClick();
    }),
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
      superProductivityProjectId: 'local-research',
    },
  ]);

  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]?.htmlContent).toContain('Missing local Vikunja projects');
  expect(dialogs[0]?.htmlContent).toContain('Research');
  expect(addedProjects).toEqual([{ title: 'Research' }]);
});

it('serializes concurrent project mirror creation and rechecks local projects', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([{ id: 2, title: 'Research', is_archived: false }]);
    }

    return taskEnvelope([{ id: 42, title: 'Imported task', project_id: 2, done: false }]);
  });
  const localProjects: Array<{ id: string; title: string }> = [];
  const addedProjects: Array<{ title: string }> = [];
  const dialogs: PluginDialogConfig[] = [];
  const host = {
    getSecret: vi.fn(async () => 'synthetic-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    getAllProjects: vi.fn(async () => localProjects),
    addProject: vi.fn(async (projectData: { title: string }) => {
      addedProjects.push(projectData);
      const localProject = { id: `local-${addedProjects.length}`, title: projectData.title };
      localProjects.push(localProject);
      return localProject.id;
    }),
    updateProject: vi.fn(async () => undefined),
    openDialog: vi.fn(async (config: PluginDialogConfig) => {
      dialogs.push(config);
      await config.buttons?.[0]?.onClick();
    }),
  };
  const definition = buildVikunjaIssueProviderDefinition(host);
  const config = {
    baseUrl: 'https://concurrent-project-sync.vikunja.example/',
    projectIds: ['2'],
    syncProjects: true,
  };

  const results = await Promise.all([
    definition.searchIssues('imported', config, http),
    definition.searchIssues('imported', config, http),
  ]);

  expect(addedProjects).toEqual([{ title: 'Research' }]);
  expect(dialogs).toHaveLength(1);
  expect(results).toHaveLength(2);
  expect(results.flat()).toEqual([
    expect.objectContaining({ superProductivityProjectId: 'local-1' }),
    expect.objectContaining({ superProductivityProjectId: 'local-1' }),
  ]);
});

it('remembers Skip for a missing project instead of prompting on every sync', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([{ id: 2, title: 'Research', is_archived: false }]);
    }

    return taskEnvelope([{ id: 42, title: 'Imported task', project_id: 2, done: false }]);
  });
  const dialogs: PluginDialogConfig[] = [];
  const host = {
    getSecret: vi.fn(async () => 'synthetic-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    getAllProjects: vi.fn(async () => []),
    addProject: vi.fn(async () => 'unexpected-new-project'),
    updateProject: vi.fn(async () => undefined),
    openDialog: vi.fn(async (config: PluginDialogConfig) => {
      dialogs.push(config);
      await config.buttons?.[1]?.onClick();
    }),
  };
  const definition = buildVikunjaIssueProviderDefinition(host);

  await definition.searchIssues('imported', {
    baseUrl: 'https://skip.vikunja.example/',
    projectIds: ['2'],
    syncProjects: true,
  }, http);
  await definition.searchIssues('imported', {
    baseUrl: 'https://skip.vikunja.example/',
    projectIds: ['2'],
    syncProjects: true,
  }, http);

  expect(dialogs).toHaveLength(1);
  expect(host.addProject).not.toHaveBeenCalled();
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
  expect(updateProject).toHaveBeenCalledWith('local-research', { title: 'Research' });
});

it('mirrors nested projects with a literal configurable prefix and full path', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([
        { id: 1, title: 'Parent', is_archived: false },
        { id: 2, title: 'Child', parent_project_id: 1, is_archived: false },
      ]);
    }

    return taskEnvelope([
      { id: 42, title: 'Nested task', project_id: 2, done: false },
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
      return 'local-child';
    }),
    updateProject: vi.fn(async () => undefined),
  };
  const definition = buildVikunjaIssueProviderDefinition(host);

  await expect(
    definition.searchIssues('nested', {
      baseUrl: 'https://vikunja.example/',
      projectIds: ['2'],
      projectPrefix: 'Work: ',
      syncProjects: true,
    }, http),
  ).resolves.toMatchObject([
    {
      id: '42',
      projectTitle: 'Parent / Child',
      superProductivityProjectId: 'local-child',
    },
  ]);

  expect(addedProjects).toEqual([
    { title: 'Work: Parent / Child' },
  ]);
});

it('includes all descendants when a parent project is selected', async () => {
  const http = createHttpStub();
  vi.mocked(http.get).mockImplementation(async (url) => {
    if (url.includes('/api/v2/projects')) {
      return projectEnvelope([
        { id: 1, title: 'Parent', parent_project_id: null, is_archived: false },
        { id: 2, title: 'Child', parent_project_id: 1, is_archived: false },
        { id: 3, title: 'Grandchild', parent_project_id: 2, is_archived: false },
      ]);
    }

    return taskEnvelope([
      { id: 42, title: 'Nested task', project_id: 3, done: false },
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
      return 'local-' + addedProjects.length;
    }),
    updateProject: vi.fn(async () => undefined),
  };
  const definition = buildVikunjaIssueProviderDefinition(host);

  await expect(
    definition.searchIssues('nested', {
      baseUrl: 'https://vikunja.example/',
      projectIds: ['1'],
      syncProjects: true,
    }, http),
  ).resolves.toMatchObject([
    {
      id: '42',
      projectId: '3',
      projectTitle: 'Parent / Child / Grandchild',
      superProductivityProjectId: 'local-3',
    },
  ]);

  expect(addedProjects).toEqual([
    { title: 'Parent' },
    { title: 'Parent / Child' },
    { title: 'Parent / Child / Grandchild' },
  ]);
});

it('preserves the local mirror project ID for post-import routing', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  expect(definition.extractSyncValues?.({
    superProductivityProjectId: 'local-child',
    vikunjaRelationsLoaded: true,
    vikunjaParentTaskId: '42',
    vikunjaParentTaskAmbiguous: false,
    vikunjaSubtaskTaskIds: ['43']
  })).toEqual({
    superProductivityProjectId: 'local-child',
    vikunjaRelationsLoaded: true,
    vikunjaParentTaskId: '42',
    vikunjaParentTaskAmbiguous: false,
    vikunjaSubtaskTaskIds: ['43']
  });
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
