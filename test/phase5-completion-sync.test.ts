import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import type { IssueProviderHttp, IssueProviderHttpOptions } from '../src/vikunja/types.js';

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

it('declares the isDone/state field mapping with the Phase 5 conversion contract', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  expect(definition.fieldMappings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        taskField: 'title',
        issueField: 'title',
        defaultDirection: 'both',
        toIssueValue: expect.any(Function),
        toTaskValue: expect.any(Function)
      }),
      expect.objectContaining({
        taskField: 'isDone',
        issueField: 'state',
        defaultDirection: 'both',
        toIssueValue: expect.any(Function),
        toTaskValue: expect.any(Function)
      })
    ]),
  );

  const mapping = definition.fieldMappings?.find((entry) => entry.taskField === 'isDone');

  expect(mapping?.toIssueValue(true, { issueId: '42' })).toBe('done');
  expect(mapping?.toIssueValue(false, { issueId: '42' })).toBe('open');
  expect(mapping?.toTaskValue('done', { issueId: '42' })).toBe(true);
  expect(mapping?.toTaskValue('open', { issueId: '42' })).toBe(false);
});

it.each([
  ['done', true],
  ['open', false]
])(
  'patches only the done field for provider state %s',
  async (state, done) => {
    const { http, patchSpy } = createHttpStub();
    const definition = buildVikunjaIssueProviderDefinition({
      getSecret: vi.fn(async () => 'synthetic-token')
    } as never);

    await expect(
      definition.updateIssue?.('42', { state }, { baseUrl: 'https://vikunja.example/root/' }, http),
    ).resolves.toBeUndefined();

    expect(patchSpy).toHaveBeenCalledWith(
      'https://vikunja.example/root/api/v2/tasks/42',
      { done },
      {
        headers: {
          Authorization: 'Bearer synthetic-token',
          'Content-Type': 'application/merge-patch+json'
        },
        responseType: 'json'
      },
    );
  },
);

it('client updateTask sends a merge patch with only the done field', async () => {
  const { http, patchSpy } = createHttpStub();
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/base/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.updateTask(123, { done: true })).resolves.toBeUndefined();

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/base/api/v2/tasks/123',
    { done: true },
    {
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/merge-patch+json'
      },
      responseType: 'json'
    },
  );
});

it('does not patch for empty or undefined completion changes', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();
  await expect(
    definition.updateIssue?.('42', { state: undefined }, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();

  expect(patchSpy).not.toHaveBeenCalled();
});

it('rejects unrelated field changes and never sends them', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', { labels: ['Wrong field'] }, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/completion state/i);
  await expect(
    definition.updateIssue?.(
      '42',
      { state: 'done', labels: ['blocked'] },
      { baseUrl: 'https://vikunja.example/' },
      http,
    ),
  ).rejects.toThrowError(/completion state/i);

  expect(patchSpy).not.toHaveBeenCalled();
});

it.each([
  ['0042', { state: 'done' }, /positive integers/i],
  ['9007199254740992', { state: 'done' }, /positive integers/i],
  ['42', { state: 'closed' }, /state must be "done" or "open"/i]
])('fails before HTTP for invalid completion update input (%s)', async (issueId, changes, message) => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.(issueId, changes, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(message);

  expect(patchSpy).not.toHaveBeenCalled();
});

it('sanitizes remote update failures without leaking token data', async () => {
  const { http, patchSpy } = createHttpStub();
  patchSpy.mockRejectedValueOnce(Object.assign(new Error('Authorization Bearer synthetic-token exploded'), {
    status: 500,
    request: {
      headers: {
        Authorization: 'Bearer synthetic-token'
      }
    }
  }));

  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  try {
    await definition.updateIssue?.('42', { state: 'done' }, { baseUrl: 'https://vikunja.example/' }, http);
    throw new Error('expected updateIssue to fail');
  } catch (error) {
    expect(error).toMatchObject({ status: 500 });
    expect(String(error)).toMatch(/task update/i);
    expect(String(error)).not.toContain('synthetic-token');
    expect(String(error)).not.toContain('Authorization');
  }
});

it('does not create another write when repeated invocations contain no new completion change', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http);
  await definition.updateIssue?.('42', {}, { baseUrl: 'https://vikunja.example/' }, http);

  expect(patchSpy).not.toHaveBeenCalled();
});
