import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { classifyRemoteTaskState } from '../src/vikunja/sync-contract.js';
import type { IssueProviderHttp } from '../src/vikunja/types.js';

it('keeps remote deletion unavailable without exposing a destructive delete callback', () => {
  const definition = buildVikunjaIssueProviderDefinition({ getSecret: vi.fn(async () => 'synthetic-token') } as never);

  expect(classifyRemoteTaskState({ status: 404, projectId: '2' })).toMatchObject({
    availability: 'unavailable',
    preserveLocalHistory: true,
    providerIdentityStable: true
  });
  expect(definition.deleteIssue).toBeUndefined();
});

it('does not issue remote deletion through the provider surface', () => {
  const definition = buildVikunjaIssueProviderDefinition({ getSecret: vi.fn(async () => 'synthetic-token') } as never);
  const http: IssueProviderHttp = {
    get: vi.fn() as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: vi.fn() as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };

  expect(definition).not.toHaveProperty('deleteIssue');
  expect(http.delete).not.toHaveBeenCalled();
});
