import { expect, it } from 'vitest';

import { buildVikunjaIssueProviderDefinition } from '../src/plugin.js';
import { mapRawTaskToIssueSummary } from '../src/vikunja/mapper.js';

it('maps multiple labels with stable remote IDs while preserving duplicate names', () => {
  const issue = mapRawTaskToIssueSummary({
    id: 42,
    title: 'Labelled',
    labels: [
      { id: 5, title: 'urgent' },
      { id: 9, title: 'urgent' },
      { id: 12, title: 'review' }
    ]
  });

  expect(issue.labels).toEqual(['urgent', 'urgent', 'review']);
  expect(issue.labelIds).toEqual(['5', '9', '12']);
});

it('maps no labels as an empty remote tag identity set', () => {
  const issue = mapRawTaskToIssueSummary({ id: 42, title: 'Unlabelled', labels: [] });

  expect(issue).toMatchObject({ labels: [], labelIds: [] });
});

it('declares pull-only tag ID mapping and does not expose label writes', () => {
  const definition = buildVikunjaIssueProviderDefinition({ getSecret: async () => 'synthetic-token' } as never);
  const mapping = definition.fieldMappings?.find((candidate) => candidate.taskField === 'tagIds');

  expect(mapping).toEqual(expect.objectContaining({
    taskField: 'tagIds',
    issueField: 'labelIds',
    defaultDirection: 'pullOnly'
  }));
  expect(definition).not.toHaveProperty('updateLabels');
});
