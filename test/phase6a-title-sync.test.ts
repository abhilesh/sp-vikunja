import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import { mapRawTaskToIssueDetails, mapRawTaskToIssueSummary } from '../src/vikunja/mapper.js';
import type { IssueProviderHttp, IssueProviderHttpOptions, VikunjaRawTask } from '../src/vikunja/types.js';

function createHttpStub() {
  const patchSpy = vi.fn(async (_url: string, _body: unknown, _options?: IssueProviderHttpOptions) => undefined);

  const http: IssueProviderHttp = {
    get: vi.fn() as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: (async <T>(
      url: string,
      body: unknown,
      options?: IssueProviderHttpOptions,
    ) => patchSpy(url, body, options) as Promise<T>) as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };

  return { http, patchSpy };
}

const rawTask: VikunjaRawTask = {
  id: 42,
  title: 'Imported title',
  description: 'Body',
  done: false,
  project_id: 7,
  labels: [{ id: 1, title: 'label' }]
};

it('maps the title field both ways through the provider field mapping', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  const titleMapping = definition.fieldMappings?.find((mapping) => mapping.taskField === 'title');

  expect(titleMapping).toEqual(
    expect.objectContaining({
      taskField: 'title',
      issueField: 'title',
      defaultDirection: 'both',
      toIssueValue: expect.any(Function),
      toTaskValue: expect.any(Function)
    }),
  );
  expect(titleMapping?.toIssueValue('Remote title', { issueId: '42' })).toBe('Remote title');
  expect(titleMapping?.toTaskValue('Local title', { issueId: '42' })).toBe('Local title');
});

it('keeps remote title data intact in the mapped issue summary and details', () => {
  expect(mapRawTaskToIssueSummary(rawTask)).toEqual(
    expect.objectContaining({
      id: '42',
      title: 'Imported title'
    }),
  );

  expect(mapRawTaskToIssueDetails(rawTask)).toEqual(
    expect.objectContaining({
      id: '42',
      title: 'Imported title',
      body: 'Body'
    }),
  );
});

it('patches only the title field when the provider writes a title update', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', { title: 'Renamed title' }, { baseUrl: 'https://vikunja.example/root/' }, http),
  ).resolves.toBeUndefined();

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/root/api/v2/tasks/42',
    { title: 'Renamed title' },
    {
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/merge-patch+json'
      },
      responseType: 'json'
    },
  );
});

it('client updateTask sends a merge patch with only the title field', async () => {
  const { http, patchSpy } = createHttpStub();
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/base/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.updateTask(123, { title: 'Renamed title' })).resolves.toBeUndefined();

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/base/api/v2/tasks/123',
    { title: 'Renamed title' },
    {
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/merge-patch+json'
      },
      responseType: 'json'
    },
  );
});

it('does not patch when title changes are empty or undefined', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();
  await expect(
    definition.updateIssue?.('42', { title: undefined }, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();

  expect(patchSpy).not.toHaveBeenCalled();
});

it('rejects unrelated title changes before any HTTP request is sent', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.(
      '42',
      { title: 'Renamed title', state: 'done' },
      { baseUrl: 'https://vikunja.example/' },
      http,
    ),
  ).rejects.toThrowError(/title/i);

  expect(patchSpy).not.toHaveBeenCalled();
});

it('does not create another write for repeated empty title updates', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http);
  await definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http);

  expect(patchSpy).not.toHaveBeenCalled();
});
