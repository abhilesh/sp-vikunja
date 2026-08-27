import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import type { PluginAPI, PluginDialogConfig } from '../src/vikunja/types.js';

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

it('exposes a local secret-backed token setup button when dialog APIs are available', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let headerButton: { label: string; onClick: () => void } | undefined;
  let dialog: PluginDialogConfig | undefined;

  api.registerHeaderButton = (button) => {
    headerButton = button;
  };
  api.openDialog = async (config) => {
    dialog = config;
  };

  registerVikunjaIssueProvider(api);
  headerButton?.onClick();

  expect(headerButton?.label).toBe('Set Vikunja Token');
  expect(dialog?.htmlContent).toContain('type="password"');
  expect(dialog?.htmlContent).toContain('Stored locally in Super Productivity secret storage');
  expect((dialog?.buttons?.[0]?.label)).toBe('Save token');
});

it('repairs the host-selected Inbox project after provider import', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.registerHook = (hook, handler) => {
    expect(hook).toBe('taskUpdate');
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-task',
    projectId: 'INBOX_PROJECT',
    issueLastSyncedValues: {
      superProductivityProjectId: 'local-vikunja-project',
    },
  });

  expect(updateTask).toHaveBeenCalledWith('local-task', {
    projectId: 'local-vikunja-project',
  });
});

it('links an imported child to an imported local parent', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      parentId: null,
      issueId: '100',
      issueProviderId: 'vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      parentId: null,
      issueId: '101',
      issueProviderId: 'vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-child',
    parentId: null,
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaParentTaskId: '100',
      vikunjaSubtaskTaskIds: []
    }
  });

  expect(updateTask).toHaveBeenCalledWith('local-child', { parentId: 'local-parent' });
});

it('links an imported child when the parent task reports its subtask relation', async () => {
  const { registerVikunjaIssueProvider } = await import('../src/plugin.js');
  const api = createPluginApiStub();
  let taskUpdateHandler: ((taskData: unknown) => void | Promise<void>) | undefined;
  const updateTask = vi.fn(async () => undefined);

  api.getTasks = vi.fn(async () => [
    {
      id: 'local-parent',
      parentId: null,
      issueId: '100',
      issueProviderId: 'vikunja-super-productivity-plugin'
    },
    {
      id: 'local-child',
      parentId: null,
      issueId: '101',
      issueProviderId: 'vikunja-super-productivity-plugin'
    }
  ]);
  api.registerHook = (_hook, handler) => {
    taskUpdateHandler = handler;
  };
  api.updateTask = updateTask;

  registerVikunjaIssueProvider(api);
  await taskUpdateHandler?.({
    id: 'local-parent',
    parentId: null,
    issueLastSyncedValues: {
      vikunjaRelationsLoaded: true,
      vikunjaSubtaskTaskIds: ['101']
    }
  });

  expect(updateTask).toHaveBeenCalledWith('local-child', { parentId: 'local-parent' });
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
      issueProviderId: 'vikunja-super-productivity-plugin'
    },
    {
      id: 'local-b',
      parentId: 'local-a',
      issueId: '101',
      issueProviderId: 'vikunja-super-productivity-plugin'
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
  expect(api.getTasks).toHaveBeenCalledOnce();
});
