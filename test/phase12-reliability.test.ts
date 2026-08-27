import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import { mapRawTaskToIssueSummary } from '../src/vikunja/mapper.js';
import { classifyRetryDisposition } from '../src/vikunja/sync-contract.js';
import type { IssueProviderHttp } from '../src/vikunja/types.js';

function createGetHttp(error: unknown): IssueProviderHttp {
  return {
    get: vi.fn(async () => { throw error; }) as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };
}

it.each([401, 403, 404, 500])('sanitizes HTTP %s failures without exposing request data', async (status) => {
  const http = createGetHttp(Object.assign(new Error('Authorization Bearer synthetic-token'), {
    status,
    request: { headers: { Authorization: 'Bearer synthetic-token' } }
  }));
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  try {
    await client.getTaskById(42);
    throw new Error('expected request to fail');
  } catch (error) {
    expect(String(error)).not.toContain('synthetic-token');
    expect(String(error)).not.toContain('Authorization');
    expect(error).toMatchObject({ status });
  }
});

it('classifies 429, network, and server failures without executing retries', () => {
  expect(classifyRetryDisposition({ status: 429, retryAfter: '30' })).toMatchObject({
    retryable: true,
    strategy: 'respect-retry-after',
    retryAfterSeconds: 30
  });
  expect(classifyRetryDisposition({ networkFailure: true })).toMatchObject({
    retryable: true,
    strategy: 'bounded-backoff-later'
  });
});

it('preserves Unicode and long descriptions without lossy mapper conversion', () => {
  const description = '研究 🚀\n\n' + 'x'.repeat(10000);
  expect(mapRawTaskToIssueSummary({ id: 42, title: 'Ünicode задача', description })).toMatchObject({
    title: 'Ünicode задача',
    description
  });
});

it('rejects malformed paginated responses before returning partial data', async () => {
  const http: IssueProviderHttp = {
    get: vi.fn(async () => ({ items: [{ id: 1, title: 'ok' }], page: 1, per_page: 50, total: 1 })) as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' })
  });

  await expect(client.searchTasks('bad')).rejects.toThrowError(/paginated response envelope/i);
});
