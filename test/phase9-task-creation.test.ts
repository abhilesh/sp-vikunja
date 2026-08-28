import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import type { IssueProviderHttp, IssueProviderHttpOptions } from '../src/vikunja/types.js';

function createHttpStub() {
  const postSpy = vi.fn(async (_url: string, _body: unknown, _options?: IssueProviderHttpOptions) => ({
    id: 99,
    title: 'Created task',
    project_id: 2,
    done: false
  }));
  const http: IssueProviderHttp = {
    get: vi.fn() as IssueProviderHttp['get'],
    post: (async <T>(url: string, body: unknown, options?: IssueProviderHttpOptions) =>
      postSpy(url, body, options) as Promise<T>) as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };
  return { http, postSpy };
}

const secretApi = { getSecret: vi.fn(async () => 'synthetic-token') } as never;

it('requires an explicit default project before creating a task', async () => {
  const { http, postSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await expect(
    definition.createIssue?.('New task', { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/default project/i);
  expect(postSpy).not.toHaveBeenCalled();
});

it('creates a Vikunja task through the official title/result contract', async () => {
  const { http, postSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await expect(
    definition.createIssue?.(
      'New task',
      { baseUrl: 'https://vikunja.example/root/', defaultProjectId: '2' },
      http,
    ),
  ).resolves.toMatchObject({
    issueId: '99',
    issueNumber: 99,
    issueData: {
      id: '99',
      title: 'Created task',
      url: 'https://vikunja.example/root/tasks/99'
    }
  });

  expect(postSpy).toHaveBeenCalledWith(
    'https://vikunja.example/root/api/v2/projects/2/tasks?format=markdown',
    {
      title: 'New task'
    },
    {
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/json'
      },
      responseType: 'json'
    },
  );
});

it('surfaces uncertain network creates for manual reconciliation without retrying', async () => {
  const { http, postSpy } = createHttpStub();
  postSpy.mockRejectedValueOnce(Object.assign(new TypeError('network timeout'), { networkFailure: true }));
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await expect(
    definition.createIssue?.(
      'Possibly created',
      { baseUrl: 'https://vikunja.example/', defaultProjectId: '2' },
      http,
    ),
  ).rejects.toMatchObject({ reconciliationRequired: true });
  expect(postSpy).toHaveBeenCalledTimes(1);
});

it('client createTask posts to the project task endpoint and decodes the response', async () => {
  const { http, postSpy } = createHttpStub();
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.createTask(2, { title: 'Created task' })).resolves.toMatchObject({ id: 99 });
  expect(postSpy).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/projects/2/tasks?format=markdown',
    { title: 'Created task' },
    expect.objectContaining({ responseType: 'json' }),
  );
});
