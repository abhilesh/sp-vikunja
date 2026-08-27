import { expect, it } from 'vitest';

import {
  DEFAULT_VIKUNJA_PROJECT_PREFIX,
  getLocalVikunjaProjectTitle,
  getRemoteIdFromLocalVikunjaProjectTitle,
  getVikunjaProjectPath
} from '../src/vikunja/project-path.js';
import type { VikunjaRawProject } from '../src/vikunja/types.js';

function projectMap(projects: VikunjaRawProject[]): Map<number, VikunjaRawProject> {
  return new Map(projects.map((project) => [project.id, project]));
}

it('builds a full path for nested projects', () => {
  const projects = [
    { id: 1, title: 'Parent' },
    { id: 2, title: 'Child', parent_project_id: 1 },
    { id: 3, title: 'Leaf', parent_project_id: 2 }
  ];

  expect(getVikunjaProjectPath(projects[2], projectMap(projects))).toBe('Parent / Child / Leaf');
  expect(getLocalVikunjaProjectTitle(projects[2], projectMap(projects), 'Work: ')).toBe(
    'Work: Parent / Child / Leaf [Vikunja:3]',
  );
});

it('falls back to the visible project when a parent is not in the response', () => {
  const project = { id: 2, title: 'Child', parent_project_id: 1 };

  expect(getVikunjaProjectPath(project, projectMap([project]))).toBe('Child');
});

it('terminates safely for cyclic parent data', () => {
  const projects = [
    { id: 1, title: 'A', parent_project_id: 2 },
    { id: 2, title: 'B', parent_project_id: 1 }
  ];

  expect(getVikunjaProjectPath(projects[0], projectMap(projects))).toBe('B / A');
});

it('recognizes canonical and legacy local mirror markers', () => {
  expect(getRemoteIdFromLocalVikunjaProjectTitle('Work: Parent [Vikunja:7]')).toBe(7);
  expect(getRemoteIdFromLocalVikunjaProjectTitle(DEFAULT_VIKUNJA_PROJECT_PREFIX + 'Old [7]')).toBe(7);
  expect(getRemoteIdFromLocalVikunjaProjectTitle('Unrelated project')).toBeUndefined();
});
