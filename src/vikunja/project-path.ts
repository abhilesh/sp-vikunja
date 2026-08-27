import type { VikunjaRawProject } from './types.js';

export const DEFAULT_VIKUNJA_PROJECT_PREFIX = 'Vikunja · ';
export const VIKUNJA_PROJECT_MARKER_PREFIX = ' [Vikunja:';

function projectTitle(project: VikunjaRawProject): string {
  return project.title.trim() || `Project ${project.id}`;
}

export function getVikunjaProjectPath(
  project: VikunjaRawProject,
  projectsById: Map<number, VikunjaRawProject>,
): string {
  const segments: string[] = [];
  const visited = new Set<number>();
  let current: VikunjaRawProject | undefined = project;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    segments.unshift(projectTitle(current));

    const parentId: number | null | undefined = current.parent_project_id;
    current = parentId === undefined || parentId === null ? undefined : projectsById.get(parentId);
  }

  return segments.join(' / ');
}

export function getLocalVikunjaProjectTitle(
  project: VikunjaRawProject,
  projectsById: Map<number, VikunjaRawProject>,
  prefix: string,
): string {
  return `${prefix}${getVikunjaProjectPath(project, projectsById)}${VIKUNJA_PROJECT_MARKER_PREFIX}${project.id}]`;
}

export function getRemoteIdFromLocalVikunjaProjectTitle(title: string): number | undefined {
  const canonicalMatch = title.match(/ \[Vikunja:(\d+)\]$/);

  if (canonicalMatch) {
    const id = Number(canonicalMatch[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  const legacyMatch = title.match(/^Vikunja · .* \[(\d+)\]$/);

  if (!legacyMatch) {
    return undefined;
  }

  const id = Number(legacyMatch[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
