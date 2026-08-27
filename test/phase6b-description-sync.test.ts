import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { mapRawTaskToIssueDetails, mapRawTaskToIssueSummary } from '../src/vikunja/mapper.js';
import type { IssueProviderHttp, IssueProviderHttpOptions, VikunjaRawTask } from '../src/vikunja/types.js';

function createHttpStub() {
  const patchSpy = vi.fn(async (_url: string, _body: unknown, _options?: IssueProviderHttpOptions) => undefined);

  const http: IssueProviderHttp = {
    get: vi.fn() as IssueProviderHttp['get'],
    post: vi.fn() as IssueProviderHttp['post'],
    put: vi.fn() as IssueProviderHttp['put'],
    patch: (async <T>(url: string, body: unknown, options?: IssueProviderHttpOptions) =>
      patchSpy(url, body, options) as Promise<T>) as IssueProviderHttp['patch'],
    delete: vi.fn() as IssueProviderHttp['delete'],
    request: vi.fn() as IssueProviderHttp['request']
  };

  return { http, patchSpy };
}

const markdownDescription = '# Heading\n\n**Bold** and <span>raw HTML</span>';

it('maps notes to an opaque Markdown description in both directions', () => {
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);
  const notesMapping = definition.fieldMappings?.find((mapping) => mapping.taskField === 'notes');

  expect(notesMapping).toEqual(expect.objectContaining({
    taskField: 'notes',
    issueField: 'description',
    defaultDirection: 'both',
    toIssueValue: expect.any(Function),
    toTaskValue: expect.any(Function)
  }));
  expect(notesMapping?.toIssueValue(markdownDescription, { issueId: '42' })).toBe(markdownDescription);
  expect(notesMapping?.toTaskValue(markdownDescription, { issueId: '42' })).toBe(markdownDescription);
  expect(notesMapping?.toIssueValue('', { issueId: '42' })).toBe('');
});

it('retains the remote description as both issue description and details body', () => {
  const task: VikunjaRawTask = { id: 42, title: 'Task', description: markdownDescription };

  expect(mapRawTaskToIssueSummary(task)).toMatchObject({ description: markdownDescription });
  expect(mapRawTaskToIssueDetails(task)).toMatchObject({ description: markdownDescription, body: markdownDescription });
});

it('patches only the description and preserves Markdown exactly', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', { description: markdownDescription }, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/tasks/42',
    { description: markdownDescription },
    {
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/merge-patch+json'
      },
      responseType: 'json'
    },
  );
});

it('allows clearing notes with an empty description', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await definition.updateIssue?.('42', { description: '' }, { baseUrl: 'https://vikunja.example/' }, http);

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/tasks/42',
    { description: '' },
    expect.any(Object),
  );
});

it('rejects mixed or unsupported description updates before HTTP', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition({
    getSecret: vi.fn(async () => 'synthetic-token')
  } as never);

  await expect(
    definition.updateIssue?.('42', { description: markdownDescription, title: 'also changed' }, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/description|title/i);
  await expect(
    definition.updateIssue?.('42', { description: 42 }, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/description/i);

  expect(patchSpy).not.toHaveBeenCalled();
});
