import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import type { IssueProviderHttp, PluginAPI, PluginDialogConfig } from '../src/vikunja/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

function createPluginApiStub(): PluginAPI {
  return {
    async getSecret() {
      return null;
    },
    async setSecret() {
      return undefined;
    },
    async deleteSecret() {
      return undefined;
    },
    registerIssueProvider(definition: unknown) {
      return definition;
    }
  };
}

it('registers the issue provider exactly once without issuing HTTP requests', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called during registration');
  });

  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');

  let registerCalls = 0;
  let capturedDefinition: unknown;
  const api: PluginAPI = createPluginApiStub();
  api.registerIssueProvider = (definition: unknown) => {
      registerCalls += 1;
      capturedDefinition = definition;
  };

  registerVikunjaIssueProvider(api);

  expect(registerCalls).toBe(1);
  expect(capturedDefinition).toEqual(expect.objectContaining({
    configFields: expect.any(Array),
    getHeaders: expect.any(Function),
    testConnection: expect.any(Function),
    searchIssues: expect.any(Function),
    getById: expect.any(Function),
    getIssueLink: expect.any(Function),
    issueDisplay: expect.any(Array),
    extractSyncValues: expect.any(Function)
  }));
  expect((capturedDefinition as { issueDisplay: Array<{ field: string; label: string }> }).issueDisplay).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'title',
        label: 'Title'
      }),
      expect.objectContaining({
        field: 'url',
        label: 'Remote Task'
      })
    ]),
  );
  expect(
    (capturedDefinition as { getIssueLink: (issueId: string, config: Record<string, unknown>) => string }).getIssueLink(
      '42',
      { baseUrl: 'https://vikunja.example/' },
    ),
  ).toBe('https://vikunja.example/tasks/42');
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('provides helper text for every Vikunja configuration option', async () => {
  const { buildVikunjaIssueProviderDefinition } = await import('../src/plugin.js');
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => null)
  } as never);

  expect(definition.configFields).toHaveLength(5);
  expect(definition.configFields.every((field) => field.description?.trim())).toBe(true);
  expect(definition.configFields.map((field) => field.description)).toEqual([
    'URL of your Vikunja server, for example https://vikunja.example. Do not append /api/v2.',
    'Prefix used for local Super Productivity project names. Leave blank for no prefix. Suggested prefix: Vikunja · ',
    'Choose which Vikunja projects to search and import. Selecting a parent includes all of its descendants. Leave empty for all accessible projects; automatic import still skips completed tasks and archived projects.',
    'Creates or updates local mirrors and assigns imported tasks to their matching project. Nested Vikunja paths appear as flat names such as Parent / Child; the plugin asks before creating missing local projects, and remote projects are never changed.',
    'Vikunja destination for tasks created from Super Productivity. This is the remote project, not the local Super Productivity project used for imported tasks.'
  ]);
});

it('auto-registers exactly once when the host PluginAPI global is present', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called during registration');
  });

  let registerCalls = 0;
  const api = createPluginApiStub();
  api.registerIssueProvider = () => {
    registerCalls += 1;
  };

  vi.stubGlobal('PluginAPI', api);

  await import('../src/plugin.js');

  expect(registerCalls).toBe(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('registers when the host runner injects PluginAPI as a function parameter', async () => {
  const buildResult = await build({
    entryPoints: ['src/plugin.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const bundledPlugin = buildResult.outputFiles[0]?.text;
  if (!bundledPlugin) {
    throw new Error('esbuild did not return the in-memory plugin bundle');
  }
  let registerCalls = 0;
  const api = createPluginApiStub();
  api.registerIssueProvider = () => {
    registerCalls += 1;
  };

  const runPlugin = new Function('plugin', 'PluginAPI', `'use strict';\n${bundledPlugin}`);
  runPlugin(api, api);

  expect(registerCalls).toBe(1);
});

it('exposes local secret-backed token setup through plugin settings', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  api.getSecret = vi.fn(async () => 'configured-token');
  let configHandler: (() => void) | undefined;
  let dialog: PluginDialogConfig | undefined;

  api.registerConfigHandler = (handler) => {
    configHandler = handler;
  };
  api.registerHeaderButton = vi.fn();
  api.openDialog = async (config) => {
    dialog = config;
  };

  registerVikunjaIssueProvider(api);
  configHandler?.();
  await vi.waitFor(() => expect(dialog).toBeDefined());

  expect(configHandler).toEqual(expect.any(Function));
  expect(api.registerHeaderButton).not.toHaveBeenCalled();
  expect(dialog?.htmlContent).toContain('type="password"');
  expect(dialog?.htmlContent).toContain('Token status:</strong> Configured on this computer.');
  expect(dialog?.htmlContent).toContain('Stored locally in Super Productivity secret storage');
  expect(dialog?.htmlContent).not.toContain('configured-token');
  expect((dialog?.buttons?.[0]?.label)).toBe('Replace token');
  expect(dialog?.buttons?.[0]?.icon).toBe('key');
});

it('repairs the host-selected Inbox project after provider import', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskCreatedHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.registerHook = (hook, handler) => {
    if (hook === 'taskCreated') {
      taskCreatedHandler = handler;
    } else {
      expect(hook).toBe('taskUpdate');
    }
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskCreatedHandler?.({
    taskId: 'local-task',
    task: {
      id: 'local-task',
      projectId: 'INBOX_PROJECT',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin',
      issueLastSyncedValues: {
        superProductivityProjectId: 'local-vikunja-project',
      },
    },
  });

  expect(updateTask).toHaveBeenCalledWith('local-task', {
    projectId: 'local-vikunja-project',
  });
});

it('repairs native backlog imports when the host omits provider sync values', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  storage.set(
    'vikunja-super-productivity-plugin.task-project-mappings',
    JSON.stringify({
      'https://vikunja.example': {
        '42': 'local-vikunja-project',
      },
    }),
  );

  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskCreatedHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.registerHook = (hook, handler) => {
    if (hook === 'taskCreated') {
      taskCreatedHandler = handler;
    }
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskCreatedHandler?.({
    taskId: 'local-task',
    task: {
      id: 'local-task',
      projectId: 'INBOX_PROJECT',
      issueId: '42',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin',
    },
  });

  expect(updateTask).toHaveBeenCalledWith('local-task', {
    projectId: 'local-vikunja-project',
  });
});


it('preserves the PluginAPI receiver while repairing existing tasks', async () => {

  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let configHandler: (() => void) | undefined;
  let settingsDialog: PluginDialogConfig | undefined;
  const showSnack = vi.fn();
  const updateTask = function (this: PluginAPI, taskId: string, updates: { projectId?: string | null }) {
    if (this !== api) {
      throw new Error('PluginAPI receiver was lost');
    }
    void taskId;
    void updates;
    return Promise.resolve();
  };

  api.getTasks = vi.fn(async () => [{
    id: 'local-task',
    projectId: 'INBOX_PROJECT',
    issueProviderId: 'provider-config-id',
    issueType: 'plugin:vikunja-super-productivity-plugin',
    issueLastSyncedValues: {
      superProductivityProjectId: 'local-vikunja-project'
    }
  }]);
  api.registerHook = () => undefined;
  api.updateTask = updateTask;
  api.showSnack = showSnack;
  api.registerConfigHandler = (handler) => {
    configHandler = handler;
  };
  api.openDialog = async (config) => {
    settingsDialog = config;
  };
  api.registerHeaderButton = vi.fn();
  api.registerMenuEntry = vi.fn();

  registerVikunjaIssueProvider(api);
  configHandler?.();
  await vi.waitFor(() => expect(settingsDialog).toBeDefined());
  const repairButton = settingsDialog?.buttons?.find((button) => button.label === 'Repair Vikunja projects');
  expect(repairButton).toBeDefined();
  await repairButton?.onClick();

  await vi.waitFor(() => expect(api.getTasks).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(showSnack).toHaveBeenCalled());
  expect(api.registerMenuEntry).not.toHaveBeenCalled();
  expect(api.registerHeaderButton).not.toHaveBeenCalled();
  expect(showSnack).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('Moved 1') }));
});

it('replays host data initialization once at startup when the host exposes it', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  const readyHandlers: Array<() => void | Promise<void>> = [];
  const reInitData = vi.fn(async () => undefined);

  api.getTasks = vi.fn(async () => []);
  api.registerHook = () => undefined;
  api.updateTask = vi.fn(async () => undefined);
  api.onReady = (handler) => {
    readyHandlers.push(handler);
  };
  api.reInitData = reInitData;

  registerVikunjaIssueProvider(api);

  expect(readyHandlers).toHaveLength(1);
  await readyHandlers[0]?.();

  expect(reInitData).toHaveBeenCalledTimes(1);
  expect(api.getTasks).toHaveBeenCalledTimes(1);
});

it('repairs a task on a later update from its stored remote project ID', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  storage.set(
    'vikunja-super-productivity-plugin.local-project-mappings',
    JSON.stringify({
      'https://vikunja.example': {
        '2': 'local-research',
      },
    }),
  );

  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.registerHook = (hook, handler) => {
    if (hook === 'taskUpdate') {
      taskUpdateHandler = handler;
    }
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    taskId: 'local-task',
    task: {
      id: 'local-task',
      projectId: 'INBOX_PROJECT',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin',
      issueLastSyncedValues: {
        vikunjaProjectId: '2',
      },
    },
  });

  expect(updateTask).toHaveBeenCalledWith('local-task', {
    projectId: 'local-research',
  });
});

it('links an imported child to an imported local parent', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);
  const batchUpdateForProject = vi.fn(async () => ({ success: true }));

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;
  api.batchUpdateForProject = batchUpdateForProject;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-child',
    projectId: 'local-project',
    parentId: null,
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaParentTaskId: '100',
      vikunjaSubtaskTaskIds: []
    }
  });

  expect(updateTask).not.toHaveBeenCalledWith(
    'local-child',
    expect.objectContaining({ parentId: expect.anything() }),
  );
  expect(batchUpdateForProject).toHaveBeenCalledWith({
    projectId: 'local-project',
    operations: [
      {
        type: 'update',
        taskId: 'local-parent',
        updates: { subTaskIds: ['local-child'] },
      },
      {
        type: 'update',
        taskId: 'local-child',
        updates: { parentId: 'local-parent' },
      },
    ],
  });
});

it('links an imported child when the parent task reports its subtask relation', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);
  const batchUpdateForProject = vi.fn(async () => ({ success: true }));

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;
  api.batchUpdateForProject = batchUpdateForProject;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-parent',
    projectId: 'local-project',
    parentId: null,
    subTaskIds: [],
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaSubtaskTaskIds: ['101']
    }
  });

  expect(batchUpdateForProject).toHaveBeenCalledWith({
    projectId: 'local-project',
    operations: [
      {
        type: 'update',
        taskId: 'local-parent',
        updates: { subTaskIds: ['local-child'] },
      },
      {
        type: 'update',
        taskId: 'local-child',
        updates: { parentId: 'local-parent' },
      },
    ],
  });
});

it('links multiple imported children in one host batch', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);
  const batchUpdateForProject = vi.fn(async () => ({ success: true }));

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child-a',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child-b',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '102',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;
  api.batchUpdateForProject = batchUpdateForProject;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-parent',
    projectId: 'local-project',
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaSubtaskTaskIds: ['101', '102']
    }
  });

  expect(batchUpdateForProject).toHaveBeenCalledTimes(1);
  const batchRequest = (batchUpdateForProject.mock.calls as unknown as Array<[{ operations: unknown[] }]>)[0]?.[0];
  expect(batchRequest?.operations).toEqual([
    {
      type: 'update',
      taskId: 'local-parent',
      updates: { subTaskIds: ['local-child-a', 'local-child-b'] },
    },
    {
      type: 'update',
      taskId: 'local-child-a',
      updates: { parentId: 'local-parent' },
    },
    {
      type: 'update',
      taskId: 'local-child-b',
      updates: { parentId: 'local-parent' },
    },
  ]);
  expect(updateTask).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ parentId: expect.anything() }),
  );
});

it('reconciles a child added after its parent was already imported', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  const updateTask = vi.fn(async () => undefined);
  const batchUpdateForProject = vi.fn(async () => ({ success: true }));
  let providerDefinition: {
    getNewIssuesForBacklog?: (config: Record<string, unknown>, http: IssueProviderHttp) => Promise<unknown[]>;
  } | undefined;

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerIssueProvider = (definition) => {
    providerDefinition = definition as typeof providerDefinition;
  };
  api.registerHook = () => undefined;
  api.getSecret = vi.fn(async () => 'synthetic-token');
  api.updateTask = updateTask;
  api.batchUpdateForProject = batchUpdateForProject;

  registerVikunjaIssueProvider(api);

  const http: IssueProviderHttp = {
    get: vi.fn(async () => ({
      items: [
        {
          id: 100,
          title: 'Parent',
          project_id: 2,
          done: false,
          related_tasks: { subtask: [{ id: 101, title: 'Child', project_id: 2 }] }
        },
        {
          id: 101,
          title: 'Child',
          project_id: 2,
          done: false
        }
      ],
      page: 1,
      per_page: 1000,
      total: 2,
      total_pages: 1
    })) as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };

  await providerDefinition?.getNewIssuesForBacklog?.({
    baseUrl: 'https://vikunja.example/'
  }, http);

  await vi.waitFor(() => expect(batchUpdateForProject).toHaveBeenCalledWith({
    projectId: 'local-project',
    operations: [
      {
        type: 'update',
        taskId: 'local-parent',
        updates: { subTaskIds: ['local-child'] },
      },
      {
        type: 'update',
        taskId: 'local-child',
        updates: { parentId: 'local-parent' },
      },
    ],
  }), { timeout: 1000 });
});

it('keeps project repair working when the host has no batch hierarchy API', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      projectId: 'local-project',
      parentId: null,
      subTaskIds: [],
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      projectId: 'INBOX_PROJECT',
      parentId: null,
      subTaskIds: [],
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-child',
    projectId: 'INBOX_PROJECT',
    issueLastSyncedValues: {
      superProductivityProjectId: 'local-project',
      vikunjaRelationsLoaded: true,
      vikunjaParentTaskId: '100',
      vikunjaSubtaskTaskIds: []
    }
  });

  expect(updateTask).toHaveBeenCalledWith('local-child', { projectId: 'local-project' });
  expect(updateTask).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ parentId: expect.anything() }),
  );
});

it('does not create a local stub or a cycle for missing or cyclic relations', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-a',
      parentId: 'local-b',
      issueId: '100',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    },
    {
      id: 'local-b',
      parentId: 'local-a',
      issueId: '101',
      issueProviderId: 'provider-config-id',
      issueType: 'plugin:vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-a',
    parentId: 'local-b',
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaParentTaskId: '999',
      vikunjaSubtaskTaskIds: ['999']
    }
  });

  expect(updateTask).not.toHaveBeenCalled();
  expect(api.getTasks).toHaveBeenCalledTimes(2);
});
