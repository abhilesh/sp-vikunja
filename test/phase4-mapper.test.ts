import { expect, it } from 'vitest';

import {
  mapRawTaskToIssueDetails,
  mapRawTaskToIssueSummary
} from '../src/vikunja/mapper.js';
import type { VikunjaRawTask } from '../src/vikunja/types.js';

const FULL_TASK_FIXTURE: VikunjaRawTask = {
  id: 42,
  title: 'Mapped task',
  description: 'Synthetic markdown body',
  done: true,
  project_id: 7,
  priority: 5,
  due_date: '2026-08-27T09:30:00Z',
  updated: '2026-08-26T08:15:30Z',
  labels: [
    { id: 1, title: 'backend' },
    { id: 2, title: 'import' }
  ]
};

it('maps a raw Vikunja task summary into the provider issue shape', () => {
  expect(mapRawTaskToIssueSummary(FULL_TASK_FIXTURE)).toEqual({
    id: '42',
    title: 'Mapped task',
    description: 'Synthetic markdown body',
    isDone: true,
    state: 'done',
    status: 'Done',
    labels: ['backend', 'import'],
    labelIds: ['1', '2'],
    projectId: '7',
    priority: 5,
    dueDate: '2026-08-27T09:30:00.000Z',
    dueDay: '2026-08-27',
    dueWithTime: '2026-08-27T09:30:00.000Z',
    lastUpdated: Date.parse('2026-08-26T08:15:30Z')
  });
});

it('maps a raw Vikunja task detail while preserving body and read-only metadata', () => {
  expect(mapRawTaskToIssueDetails(FULL_TASK_FIXTURE)).toEqual({
    id: '42',
    title: 'Mapped task',
    description: 'Synthetic markdown body',
    body: 'Synthetic markdown body',
    isDone: true,
    state: 'done',
    status: 'Done',
    labels: ['backend', 'import'],
    labelIds: ['1', '2'],
    projectId: '7',
    priority: 5,
    dueDate: '2026-08-27T09:30:00.000Z',
    dueDay: '2026-08-27',
    dueWithTime: '2026-08-27T09:30:00.000Z',
    lastUpdated: Date.parse('2026-08-26T08:15:30Z')
  });
});

it('keeps optional fields absent when the raw task does not provide them', () => {
  expect(mapRawTaskToIssueDetails({
    id: 9,
    title: 'Minimal task',
    done: false,
    updated: 'not-a-real-date'
  })).toEqual({
    id: '9',
    title: 'Minimal task',
    isDone: false,
    state: 'open',
    status: 'Open'
  });
});

it('preserves a newer remote timestamp for host polling comparisons', () => {
  const first = mapRawTaskToIssueDetails({
    id: 42,
    title: 'Timestamped task',
    done: false,
    updated: '2026-08-26T08:15:30Z'
  });
  const second = mapRawTaskToIssueDetails({
    id: 42,
    title: 'Timestamped task',
    done: true,
    updated: '2026-08-26T08:15:31Z'
  });

  expect(first).toMatchObject({ isDone: false, state: 'open' });
  expect(second).toMatchObject({ isDone: true, state: 'done' });
  expect(second.lastUpdated).toBeGreaterThan(first.lastUpdated ?? 0);
});

it('ignores blank or malformed remote timestamps', () => {
  expect(mapRawTaskToIssueDetails({
    id: 10,
    title: 'No timestamp',
    done: false,
    updated: '   '
  }).lastUpdated).toBeUndefined();

  expect(mapRawTaskToIssueDetails({
    id: 11,
    title: 'Malformed timestamp',
    done: false,
    updated: 'not-a-real-date'
  }).lastUpdated).toBeUndefined();
});
