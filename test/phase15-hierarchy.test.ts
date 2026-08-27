import { expect, it } from 'vitest';

import {
  mapRawTaskToIssueDetails,
  mapRawTaskToIssueSummary
} from '../src/vikunja/mapper.js';

it('maps a returned subtask relation to pull-only hierarchy metadata', () => {
  const mapped = mapRawTaskToIssueSummary({
    id: 100,
    title: 'Parent',
    related_tasks: {
      subtask: [{ id: 101, title: 'Child' }]
    }
  });

  expect(mapped).toMatchObject({
    vikunjaRelationsLoaded: true,
    vikunjaSubtaskTaskIds: ['101']
  });
  expect(mapped.vikunjaParentTaskId).toBeUndefined();
});

it('maps a returned parent relation to a single local parent candidate', () => {
  const mapped = mapRawTaskToIssueDetails({
    id: 101,
    title: 'Child',
    related_tasks: {
      parenttask: [{ id: 100, title: 'Parent' }]
    }
  });

  expect(mapped).toMatchObject({
    vikunjaRelationsLoaded: true,
    vikunjaParentTaskId: '100',
    vikunjaParentTaskAmbiguous: false
  });
});

it('does not select an ambiguous parent relation', () => {
  const mapped = mapRawTaskToIssueSummary({
    id: 101,
    title: 'Child',
    related_tasks: {
      parenttask: [
        { id: 100, title: 'Parent A' },
        { id: 102, title: 'Parent B' },
        { id: 100, title: 'Parent A duplicate' }
      ]
    }
  });

  expect(mapped).toMatchObject({
    vikunjaRelationsLoaded: true,
    vikunjaParentTaskAmbiguous: true
  });
  expect(mapped.vikunjaParentTaskId).toBeUndefined();
});

it('keeps relation metadata absent when subtasks were not expanded', () => {
  const mapped = mapRawTaskToIssueSummary({
    id: 100,
    title: 'Parent'
  });

  expect(mapped).not.toHaveProperty('vikunjaRelationsLoaded');
  expect(mapped).not.toHaveProperty('vikunjaSubtaskTaskIds');
  expect(mapped).not.toHaveProperty('vikunjaParentTaskId');
});
