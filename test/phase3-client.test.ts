import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import type { IssueProviderHttp, IssueProviderHttpOptions } from '../src/vikunja/types.js';

function createHttpStub(
  handler: (url: string, options?: IssueProviderHttpOptions) => Promise<unknown>,
): { http: IssueProviderHttp; getSpy: ReturnType<typeof vi.fn> } {
  const getSpy = vi.fn(async (url: string, options?: IssueProviderHttpOptions) => handler(url, options));
  const get: IssueProviderHttp['get'] = async <T>(
    url: string,
    options?: IssueProviderHttpOptions,
  ) => getSpy(url, options) as Promise<T>;

  return {
    http: {
      get,
      post: vi.fn() as IssueProviderHttp['post'],
      put: vi.fn() as IssueProviderHttp['put'],
      patch: vi.fn() as IssueProviderHttp['patch'],
      delete: vi.fn() as IssueProviderHttp['delete'],
      request: vi.fn() as IssueProviderHttp['request']
    },
    getSpy
  };
}

it('searches tasks by sending an encoded request URL with q and format=markdown', async () => {
  const { http, getSpy } = createHttpStub(async () => ({
    items: [{ id: 42, title: 'Test task' }],
    page: 1,
    per_page: 50,
    total: 1,
    total_pages: 1
  }));
  const getHeaders = vi.fn(async () => ({ Authorization: 'Bearer synthetic-token' }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/root/',
    http,
    getHeaders
  });

  await expect(client.searchTasks('deploy + docs')).resolves.toEqual([
    { id: 42, title: 'Test task' }
  ]);
  expect(getSpy).toHaveBeenCalledWith(
    'https://vikunja.example/root/api/v2/tasks?q=deploy+%2B+docs&page=1&per_page=50&format=markdown',
    {
      headers: {
        Authorization: 'Bearer synthetic-token'
      },
      responseType: 'json'
    },
  );
  expect(getHeaders).toHaveBeenCalledTimes(1);
});
it('requests expanded subtasks when hierarchy metadata is requested', async () => {
  const { http, getSpy } = createHttpStub(async (url) => {
    if (url.includes('/tasks?')) {
      return {
        items: [{ id: 42, title: 'Parent', related_tasks: { subtask: [{ id: 43, title: 'Child' }] } }],
        page: 1,
        per_page: 50,
        total: 1,
        total_pages: 1
      };
    }

    return {
      id: 42,
      title: 'Parent',
      related_tasks: { subtask: [{ id: 43, title: 'Child' }] }
    };
  });
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await client.searchTasks('parent', { includeSubtasks: true });
  await client.getTaskById(42, { includeSubtasks: true });

  expect(getSpy).toHaveBeenNthCalledWith(
    1,
    'https://vikunja.example/api/v2/tasks?q=parent&page=1&per_page=50&format=markdown&expand=subtasks',
    expect.objectContaining({ responseType: 'json' }),
  );
  expect(getSpy).toHaveBeenNthCalledWith(
    2,
    'https://vikunja.example/api/v2/tasks/42',
    expect.objectContaining({
      params: { format: 'markdown', expand: 'subtasks' }
    }),
  );
});

it('accepts Vikunja tasks whose labels field is null when no labels are assigned', async () => {
  const { http } = createHttpStub(async () => ({
    items: [{
      id: 42,
      title: 'Unlabelled task',
      description: '',
      done: false,
      project_id: 22,
      priority: 0,
      due_date: '0001-01-01T00:00:00Z',
      updated: '2026-08-27T08:15:30Z',
      labels: null
    }],
    page: 1,
    per_page: 50,
    total: 1,
    total_pages: 1
  }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.searchTasks('unlabelled')).resolves.toMatchObject([
    { id: 42, title: 'Unlabelled task', labels: null }
  ]);
});

it('decodes empty and multi-page task envelopes by following total_pages', async () => {
  const { http, getSpy } = createHttpStub(async (_url, options) => {
    const page = new URL(_url).searchParams.get('page');

    if (page === '1') {
      return {
        items: [{ id: 1, title: 'Page 1 task' }],
        page: 1,
        per_page: 1,
        total: 2,
        total_pages: 2
      };
    }

    if (page === '2') {
      return {
        items: [{ id: 2, title: 'Page 2 task' }],
        page: 2,
        per_page: 1,
        total: 2,
        total_pages: 2
      };
    }

    return {
      items: [],
      page: 1,
      per_page: 50,
      total: 0,
      total_pages: 0
    };
  });
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.searchTasks('paged', { perPage: 1 })).resolves.toEqual([
    { id: 1, title: 'Page 1 task' },
    { id: 2, title: 'Page 2 task' }
  ]);
  expect(getSpy).toHaveBeenCalledTimes(2);
});

it.each([
  [
    'page below 1',
    {
      items: [{ id: 1, title: 'Task' }],
      page: 0,
      per_page: 50,
      total: 1,
      total_pages: 1
    }
  ],
  [
    'per_page above 1000',
    {
      items: [{ id: 1, title: 'Task' }],
      page: 1,
      per_page: 1001,
      total: 1,
      total_pages: 1
    }
  ],
  [
    'negative total',
    {
      items: [{ id: 1, title: 'Task' }],
      page: 1,
      per_page: 50,
      total: -1,
      total_pages: 1
    }
  ],
  [
    'negative total_pages',
    {
      items: [{ id: 1, title: 'Task' }],
      page: 1,
      per_page: 50,
      total: 1,
      total_pages: -1
    }
  ],
  [
    'fractional pagination values',
    {
      items: [{ id: 1, title: 'Task' }],
      page: 1.5,
      per_page: 50.5,
      total: 1.25,
      total_pages: 1.75
    }
  ]
])('rejects malformed task envelopes with %s', async (_label, envelope) => {
  const { http } = createHttpStub(async () => envelope);
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.searchTasks('bad envelope')).rejects.toThrowError(
    /Invalid Vikunja paginated response envelope/i,
  );
});

it('decodes empty and multi-page project envelopes by following total_pages', async () => {
  const { http, getSpy } = createHttpStub(async (_url, options) => {
    if (options?.params?.page === '1') {
      return {
        items: [{ id: 7, title: 'Inbox' }],
        page: 1,
        per_page: 1,
        total: 2,
        total_pages: 2
      };
    }

    return {
      items: [{ id: 8, title: 'Roadmap' }],
      page: 2,
      per_page: 1,
      total: 2,
      total_pages: 2
    };
  });
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.listProjects({ perPage: 1 })).resolves.toEqual([
    { id: 7, title: 'Inbox' },
    { id: 8, title: 'Roadmap' }
  ]);
  expect(getSpy).toHaveBeenCalledTimes(2);
});

it('fetches one task by integer id and includes format=markdown', async () => {
  const { http, getSpy } = createHttpStub(async () => ({
    id: 123,
    title: 'Look up task',
    description: 'body'
  }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/base/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.getTaskById(123)).resolves.toEqual({
    id: 123,
    title: 'Look up task',
    description: 'body'
  });
  expect(getSpy).toHaveBeenCalledWith(
    'https://vikunja.example/base/api/v2/tasks/123',
    expect.objectContaining({
      params: {
        format: 'markdown'
      }
    }),
  );
});

it.each(['42abc', '0042', ' 42', '+42'])(
  'rejects non-canonical task ids before HTTP (%s)',
  async (issueId) => {
    const { http, getSpy } = createHttpStub(async () => ({
      id: 42,
      title: 'Should not be fetched'
    }));
    const definition = buildVikunjaIssueProviderDefinition({
      getSecret: vi.fn(async () => 'synthetic-token')
    } as never);

    await expect(
      definition.getById(issueId, { baseUrl: 'https://vikunja.example/' }, http),
    ).rejects.toThrowError(/positive integers/i);
    expect(getSpy).not.toHaveBeenCalled();
  },
);

it('rejects malformed paginated envelopes clearly', async () => {
  const { http } = createHttpStub(async () => ({
    items: 'not-an-array',
    page: 1,
    per_page: 50,
    total: 0,
    total_pages: 0
  }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.searchTasks('bad envelope')).rejects.toThrowError(
    /Invalid Vikunja task list response envelope/i,
  );
});

it('supplies auth headers through the injected header provider for every request', async () => {
  const { http } = createHttpStub(async (url, options) => {
    expect(options?.headers).toEqual({ Authorization: 'Bearer synthetic-token' });

    if (url.endsWith('/projects')) {
      return {
        items: [],
        page: 1,
        per_page: 1,
        total: 0,
        total_pages: 0
      };
    }

    return {
      id: 5,
      title: 'One task'
    };
  });
  const getHeaders = vi.fn(async () => ({ Authorization: 'Bearer synthetic-token' }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders
  });

  await client.listProjects({ perPage: 1 });
  await client.getTaskById(5);

  expect(getHeaders).toHaveBeenCalledTimes(2);
});

it('propagates HTTP failures without leaking authorization headers or token values', async () => {
  const error = new Error('request failed');
  Object.assign(error, {
    status: 500,
    request: {
      headers: {
        Authorization: 'Bearer synthetic-token'
      }
    }
  });
  const { http } = createHttpStub(async () => {
    throw error;
  });
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  try {
    await client.searchTasks('failure');
    throw new Error('expected search to fail');
  } catch (caught) {
    expect(caught).toMatchObject({ status: 500 });
    expect(String(caught)).toMatch(/task search/i);
    expect(String(caught)).not.toContain('synthetic-token');
    expect(String(caught)).not.toContain('Authorization');
  }
});

it('uses the client for provider search, fetch, and connection callbacks', async () => {
  const secretApi = {
    getSecret: vi.fn(async () => 'synthetic-token')
  };
  const { http } = createHttpStub(async (url, options) => {
    if (url.endsWith('/projects')) {
      expect(options?.params).toEqual({
        page: '1',
        per_page: '1'
      });
      return {
        items: [{ id: 2, title: 'Inbox' }],
        page: 1,
        per_page: 1,
        total: 1,
        total_pages: 1
      };
    }

    if (url.endsWith('/tasks/42')) {
      expect(options?.params).toEqual({ format: 'markdown', expand: 'subtasks' });
      return {
        id: 42,
        title: 'Imported task',
        description: 'markdown body',
        done: false,
        project_id: 9,
        priority: 3,
        due_date: '2026-08-27T09:30:00Z',
        updated: '2026-08-26T08:15:30Z',
        labels: [{ id: 1, title: 'imported' }]
      };
    }

    expect(url).toBe(
      'https://vikunja.example/api/v2/tasks?q=imported&page=1&per_page=50&format=markdown&expand=subtasks',
    );
    expect(options).toEqual({
      headers: {
        Authorization: 'Bearer synthetic-token'
      },
      responseType: 'json'
    });
    return {
      items: [{
        id: 42,
        title: 'Imported task',
        description: 'markdown body',
        done: false,
        project_id: 9,
        priority: 3,
        due_date: '2026-08-27T09:30:00Z',
        updated: '2026-08-26T08:15:30Z',
        labels: [{ id: 1, title: 'imported' }]
      }],
      page: 1,
      per_page: 50,
      total: 1,
      total_pages: 1
    };
  });

  const definition = buildVikunjaIssueProviderDefinition(secretApi as never);

  await expect(
    definition.testConnection?.({ baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBe(true);
  await expect(
    definition.searchIssues('imported', { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toEqual([
    {
      id: '42',
      title: 'Imported task',
      description: 'markdown body',
      isDone: false,
      state: 'open',
      status: 'Open',
      labels: ['imported'],
      labelIds: ['1'],
      projectId: '9',
      priority: 3,
      dueDate: '2026-08-27T09:30:00.000Z',
      dueDay: '2026-08-27',
      dueWithTime: '2026-08-27T09:30:00.000Z',
      lastUpdated: Date.parse('2026-08-26T08:15:30Z')
    }
  ]);
  await expect(
    definition.getById('42', { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toEqual({
    id: '42',
    title: 'Imported task',
    description: 'markdown body',
    body: 'markdown body',
    isDone: false,
    state: 'open',
    status: 'Open',
    labels: ['imported'],
    labelIds: ['1'],
    projectId: '9',
    priority: 3,
    dueDate: '2026-08-27T09:30:00.000Z',
    dueDay: '2026-08-27',
    dueWithTime: '2026-08-27T09:30:00.000Z',
    lastUpdated: Date.parse('2026-08-26T08:15:30Z')
  });
});

it('builds the verified frontend task URL from the normalized configured base URL', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  expect(definition.getIssueLink('42', { baseUrl: 'https://vikunja.example/' })).toBe(
    'https://vikunja.example/tasks/42',
  );
  expect(definition.getIssueLink('42', { baseUrl: 'https://vikunja.example/root/app/' })).toBe(
    'https://vikunja.example/root/app/tasks/42',
  );
});

it.each(['42abc', '0042', ' 42', '+42'])(
  'rejects malformed task ids before constructing issue links (%s)',
  (issueId) => {
    const definition = buildVikunjaIssueProviderDefinition({
      getSecret: vi.fn(async () => 'synthetic-token')
    } as never);

    expect(() => definition.getIssueLink(issueId, { baseUrl: 'https://vikunja.example/' })).toThrowError(
      /canonical positive integers/i,
    );
  },
);
