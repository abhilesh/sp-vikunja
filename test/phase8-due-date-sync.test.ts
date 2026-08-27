import { expect, it, vi } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { mapRawTaskToIssueSummary } from '../src/vikunja/mapper.js';
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

const secretApi = { getSecret: vi.fn(async () => 'synthetic-token') } as never;

it('maps a Vikunja date-time to explicit UTC dueDay and dueWithTime values', () => {
  const task: VikunjaRawTask = { id: 42, title: 'Dated', due_date: '2026-08-27T23:30:00-02:00' };
  const issue = mapRawTaskToIssueSummary(task);

  expect(issue).toMatchObject({
    dueDay: '2026-08-28',
    dueWithTime: '2026-08-28T01:30:00.000Z',
    dueDate: '2026-08-28T01:30:00.000Z'
  });
});

it('treats Vikunja year-1 zero due dates as absent', () => {
  expect(mapRawTaskToIssueSummary({
    id: 42,
    title: 'Undated',
    due_date: '0001-01-01T00:00:00Z'
  })).not.toHaveProperty('dueDay');
});

it('declares dueDay and dueWithTime mappings with the documented UTC conversions', () => {
  const definition = buildVikunjaIssueProviderDefinition(secretApi);
  const dueDay = definition.fieldMappings?.find((mapping) => mapping.taskField === 'dueDay');
  const dueWithTime = definition.fieldMappings?.find((mapping) => mapping.taskField === 'dueWithTime');

  expect(dueDay?.toIssueValue('2026-08-27', { issueId: '42' })).toBe('2026-08-27');
  expect(dueDay?.toTaskValue('2026-08-27T23:30:00-02:00', { issueId: '42' })).toBe('2026-08-28');
  expect(dueWithTime?.toIssueValue(Date.parse('2026-08-27T09:30:00Z'), { issueId: '42' })).toBe('2026-08-27T09:30:00.000Z');
  expect(dueWithTime?.toTaskValue('2026-08-27T09:30:00Z', { issueId: '42' })).toBe(Date.parse('2026-08-27T09:30:00Z'));
});

it.each([
  ['dueDay', '2026-08-27', '2026-08-27T00:00:00.000Z'],
  ['dueWithTime', '2026-08-27T09:30:00+01:00', '2026-08-27T08:30:00.000Z'],
  ['dueDay', null, '0001-01-01T00:00:00.000Z']
])('writes only the %s due-date change', async (field, value, dueDate) => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await expect(
    definition.updateIssue?.('42', { [field]: value }, { baseUrl: 'https://vikunja.example/' }, http),
  ).resolves.toBeUndefined();

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/tasks/42',
    { due_date: dueDate },
    expect.any(Object),
  );
});

it('rejects malformed dates and mixed due-date updates before HTTP', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await expect(
    definition.updateIssue?.('42', { dueDay: '27/08/2026' }, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/date/i);
  await expect(
    definition.updateIssue?.('42', { dueDay: '2026-08-27', dueWithTime: '2026-08-27T00:00:00Z' }, { baseUrl: 'https://vikunja.example/' }, http),
  ).rejects.toThrowError(/due/i);
  expect(patchSpy).not.toHaveBeenCalled();
});

it('accepts Super Productivity timestamp numbers when updating Vikunja', async () => {
  const { http, patchSpy } = createHttpStub();
  const definition = buildVikunjaIssueProviderDefinition(secretApi);

  await definition.updateIssue?.(
    '42',
    { dueWithTime: Date.parse('2026-08-27T09:30:00Z') },
    { baseUrl: 'https://vikunja.example/' },
    http,
  );

  expect(patchSpy).toHaveBeenCalledWith(
    'https://vikunja.example/api/v2/tasks/42',
    { due_date: '2026-08-27T09:30:00.000Z' },
    expect.any(Object),
  );
});
