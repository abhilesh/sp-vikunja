import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { findReopenedVikunjaTasks } from '../src/vikunja/reopened-tasks.js';
import type { IssueProviderHttp } from '../src/vikunja/types.js';

function createHost(overrides: Record<string, unknown> = {}) {
  return {
    getSecret: vi.fn(async () => 'synthetic-token'),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

function createHttp(): IssueProviderHttp {
  return {
    get: vi.fn(async (url: string) => {
      if (url.includes('/projects')) {
        return {
          items: [{ id: 13, title: 'Chores', is_archived: false }],
          page: 1,
          per_page: 1000,
          total: 1,
          total_pages: 1,
        };
      }

      return {
        items: [
          {
            id: 276,
            title: 'Pay Rent for Tillermans Court',
            project_id: 13,
            done: false,
            repeat_after: 2592000,
            repeat_mode: 0,
          },
        ],
        page: 1,
        per_page: 1000,
        total: 1,
        total_pages: 1,
      };
    }) as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request'],
  };
}

it('detects reopened Vikunja tasks without treating unrelated archive entries as matches', () => {
  expect(findReopenedVikunjaTasks(
    [
      {
        id: '276',
        title: 'Pay Rent for Tillermans Court',
        isDone: false,
        vikunjaIsRecurring: true,
      },
      { id: '277', title: 'Still done remotely', isDone: true },
    ],
    [
      {
        id: 'local-276',
        title: 'Pay Rent for Tillermans Court',
        isDone: true,
        issueId: '276',
        issueProviderId: 'provider-instance',
        issueType: 'plugin:vikunja-super-productivity-plugin',
      },
      {
        id: 'local-277',
        issueId: '277',
        issueProviderId: 'other-provider',
        issueType: 'plugin:other-provider',
      },
    ],
  )).toEqual([
    {
      remoteIssueId: '276',
      remoteTitle: 'Pay Rent for Tillermans Court',
      remoteIsRecurring: true,
      archivedTaskId: 'local-276',
      archivedTaskTitle: 'Pay Rent for Tillermans Court',
    },
  ]);
});

it('preserves Vikunja recurrence metadata in mapped backlog issues', async () => {
  const definition = buildVikunjaIssueProviderDefinition(createHost());

  const issue = (await definition.getNewIssuesForBacklog?.(
    { baseUrl: 'https://vikunja.example/' },
    createHttp(),
  ))?.[0];

  expect(issue).toMatchObject({
    id: '276',
    vikunjaRepeatAfter: 2592000,
    vikunjaRepeatMode: 0,
    vikunjaIsRecurring: true,
  });
});

it('warns once when the current host cannot restore a reopened archived task', async () => {
  const showSnack = vi.fn();
  const getArchivedTasks = vi.fn(async () => [
    {
      id: 'local-276',
      title: 'Pay Rent for Tillermans Court',
      isDone: true,
      issueId: '276',
      issueType: 'plugin:vikunja-super-productivity-plugin',
      issueProviderId: 'provider-instance',
    },
  ]);
  const definition = buildVikunjaIssueProviderDefinition(createHost({
    getArchivedTasks,
    showSnack,
  }));
  const config = { baseUrl: 'https://vikunja.example/' };

  await definition.getNewIssuesForBacklog?.(config, createHttp());
  await definition.getNewIssuesForBacklog?.(config, createHttp());

  expect(getArchivedTasks).toHaveBeenCalledTimes(2);
  expect(showSnack).toHaveBeenCalledTimes(1);
  expect(showSnack).toHaveBeenCalledWith(expect.objectContaining({
    type: 'INFO',
    ico: 'restore',
    msg: expect.stringContaining('Restore the existing task from Worklog'),
  }));
});

it('reminds once when a recurring task is imported without an archived match', async () => {
  const showSnack = vi.fn();
  const definition = buildVikunjaIssueProviderDefinition(createHost({
    getArchivedTasks: vi.fn(async () => []),
    showSnack,
  }));
  const config = { baseUrl: 'https://vikunja.example/' };

  await definition.getNewIssuesForBacklog?.(config, createHttp());
  await definition.getNewIssuesForBacklog?.(config, createHttp());

  expect(showSnack).toHaveBeenCalledTimes(1);
  expect(showSnack).toHaveBeenCalledWith(expect.objectContaining({
    type: 'INFO',
    ico: 'repeat',
    msg: expect.stringContaining('Vikunja remains the recurrence owner'),
  }));
});

it('uses the host restore capability when it is available and does not notify', async () => {
  const restoreTask = vi.fn(async () => undefined);
  const showSnack = vi.fn();
  const definition = buildVikunjaIssueProviderDefinition(createHost({
    getArchivedTasks: vi.fn(async () => [
      {
        id: 'local-276',
        issueId: '276',
        issueType: 'plugin:vikunja-super-productivity-plugin',
      },
    ]),
    restoreTask,
    showSnack,
  }));

  await definition.getNewIssuesForBacklog?.(
    { baseUrl: 'https://vikunja.example/' },
    createHttp(),
  );

  expect(restoreTask).toHaveBeenCalledWith('local-276');
  expect(showSnack).not.toHaveBeenCalled();
});
