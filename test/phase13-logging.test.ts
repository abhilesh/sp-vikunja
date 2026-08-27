import { expect, it, vi } from 'vitest';

import { createSafeVikunjaLogger, redactVikunjaLogValue } from '../src/vikunja/logging.js';
import { createVikunjaClient } from '../src/vikunja/client.js';
import type { IssueProviderHttp } from '../src/vikunja/types.js';

it('redacts credentials and task content from nested diagnostic values', () => {
  expect(redactVikunjaLogValue({
    Authorization: 'Bearer synthetic-token',
    password: 'secret',
    title: 'Private task title',
    nested: { description: 'Private task body', status: 500 }
  })).toEqual({
    Authorization: '[REDACTED]',
    password: '[REDACTED]',
    title: '[OMITTED]',
    nested: { description: '[OMITTED]', status: 500 }
  });
});

it('emits only safe structured request failure events', async () => {
  const events: unknown[] = [];
  const logger = createSafeVikunjaLogger((event) => events.push(event));
  const http: IssueProviderHttp = {
    get: vi.fn(async () => { throw Object.assign(new Error('Bearer synthetic-token'), { status: 500 }); }) as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };
  const client = createVikunjaClient({
    baseUrl: 'https://vikunja.example/',
    http,
    getHeaders: async () => ({ Authorization: 'Bearer synthetic-token' }),
    logger
  });

  await expect(client.getTaskById(42)).rejects.toThrowError(/task fetch/i);
  expect(events).toEqual([
    { event: 'request', operation: 'task fetch' },
    { event: 'request-failure', operation: 'task fetch', status: 500 }
  ]);
  expect(JSON.stringify(events)).not.toContain('synthetic-token');
});
