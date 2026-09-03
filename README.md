# Vikunja for Super Productivity

A Super Productivity issue-provider plugin for connecting [Vikunja](https://vikunja.io/) to [Super Productivity](https://super-productivity.com/) through the Vikunja REST API v2.

## Features

- Search and import Vikunja tasks from the Super Productivity issue panel.
- Import all matching active tasks through Super Productivity's native backlog-import flow.
- Keep imported tasks linked to their original Vikunja tasks.
- Synchronize titles, Markdown notes, completion state, and due dates in both directions.
- Create new Vikunja tasks from Super Productivity in a selected Vikunja project.
- Search all accessible Vikunja projects or select a project subtree.
- Optionally mirror Vikunja project paths as local Super Productivity projects.
- Ask before creating missing local project mirrors.
- Pull existing Vikunja labels without creating or changing labels remotely.
- Preserve subtask relationships locally when the host API supports the required update.

Vikunja is the source of truth for remote task fields. Project mirroring is
pull-only: the plugin does not create, rename, move, or delete projects in
Vikunja.

## Requirements

- Super Productivity 18.19.0 or newer.
- A Vikunja server with REST API v2 enabled.
- A Vikunja API token that can access the projects and tasks you want to use.

Use an HTTPS Vikunja URL for normal use. Local HTTP servers require the
Super Productivity host's private-network policy to allow the connection.

## Installation

### Build from source

```bash
npm ci
npm test
npm run typecheck
npm run package
```

The installable archive is:

```text
dist/vikunja-super-productivity-plugin-0.3.14.zip
```

The ZIP contains `manifest.json`, `icon.svg`, and `plugin.js` at its root.

### Install in Super Productivity

1. Open `Settings → Plugins → Choose Plugin File`.
2. Select `vikunja-super-productivity-plugin-0.3.14.zip`.
3. Enable the Vikunja issue provider if it is not enabled automatically.
4. Configure the provider using the steps below.

## Configuration

1. Open `Settings → Plugins`, select Vikunja, and use the plugin card's
   Settings action to open the token dialog. The token is stored in local
   Super Productivity secret storage. It is not part of provider configuration,
   sync data, source files, or the plugin archive.
2. Set `Vikunja base URL`. Enter the server URL without `/api/v2`; the plugin
   adds that path itself.
3. Choose the Vikunja projects to search/import, or leave the selector empty
   for all accessible projects.
4. Set `Default project for new tasks` if tasks created from Super Productivity
   should be sent to Vikunja.
5. Set `Local project prefix`, or leave it blank for no prefix.
6. Enable `Preserve Vikunja project structure locally` if imported tasks should
   be routed to local mirrors named from their Vikunja paths.
7. In `Advanced Config`, choose `Default Super Productivity Project` as the
   temporary staging project used by the host's bulk importer.
8. Enable `Auto import to default project (requires a default project)` to
   enable automatic import. Older Super Productivity versions may call this
   `Auto-add to backlog`.
9. Enable `Poll imported for changes and notify` and select an appropriate
   `Polling trigger`. `always` is the most predictable option for an initial
   import.

## Usage

### Import a single task

1. Open the Super Productivity issue panel and select `Vikunja`.
2. Search by task title and select the matching Vikunja result.
3. Use the normal Super Productivity import action to add the task.
4. If project mirroring is enabled, the plugin routes the task to its matching local mirror after import.

### Import all active tasks

Leave `Vikunja projects to import/search` empty and enable the automatic import
option under `Advanced Config`. Super Productivity then asks this provider for
all matching unlinked tasks. Completed tasks and tasks in archived Vikunja
projects are excluded from automatic import.

The host may briefly place imported tasks in the configured staging project.
When project mirroring is enabled, the plugin records each task's destination
and moves it to the matching local mirror after import. If a mirror is missing,
the plugin asks whether to create it. Choosing `Skip` leaves those tasks in the
staging project and remembers that decision for that Vikunja server/project.

Use the following maintenance actions when needed. Open `Settings → Plugins`,
select Vikunja, and click the plugin card's Settings action:

- `Repair Vikunja projects` rechecks existing imported tasks and moves tasks to
  known matching mirrors.
- `Reset Vikunja project prompt decisions` allows previously skipped missing
  projects to prompt again.

Selecting a parent Vikunja project includes its descendants. Because the public
Super Productivity plugin API does not expose parent-project creation, nested
paths are represented as stable flat local names such as `Parent / Child`.

### Create a new Vikunja task

Set `Default project for new tasks` to the remote Vikunja project that should receive new tasks. Then use the normal Super Productivity create-task or issue-provider flow while Vikunja is selected. The task is created remotely in that project; local project mirroring remains pull-only.

### Update and sync tasks

After import, edit the task normally in either application. Titles, Markdown notes, completion state, and due dates are synchronized in both directions during the host synchronization cycle. Local project placement, Super Productivity time tracking, planning, and focus data remain local to Super Productivity.

### Update the plugin or move to another computer

For an in-place plugin update, install the newer ZIP and reload Super Productivity. Existing linked tasks, provider configuration, local project mappings, and time tracking belong to the Super Productivity profile and are not stored in the plugin ZIP. On a new computer, migrate or import the Super Productivity data separately, then enter the Vikunja token again through the plugin card Settings action.

### Troubleshooting

- Tasks still in the staging project: enable project mirroring, create or approve the missing local mirrors, then open Vikunja Settings and click `Repair Vikunja projects`.
- A project prompt was skipped: open Vikunja Settings and click `Reset Vikunja project prompt decisions`, then search or import again.
- Connection or backlog import errors: verify the base URL, token, project filter, and the host network permission. Do not append `/api/v2` to the configured base URL.

## Plugin settings, maintenance actions, and icons

Connection setup is available through the Vikunja plugin card's Settings action
under `Settings → Plugins`. The plugin does not add a permanent Connect button
to Super Productivity's main top bar.

The Settings icon on the plugin card is supplied by Super Productivity and
cannot be replaced by this plugin.

The Vikunja Settings dialog includes:

- `Save token` / `Replace token` uses the built-in `key` icon.
- `Repair Vikunja projects` uses the built-in `account_tree` icon.
- `Reset Vikunja project prompt decisions` uses the built-in `refresh` icon.

The bundled monochrome Vikunja SVG is used for the plugin card and issue-panel
provider.

Standard Super Productivity examples commonly use a side-panel entry or
keyboard shortcut rather than a persistent header button. Header buttons remain
available through the API for plugins that need frequent one-click actions. See
the [official plugin development guide](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md)
and the [official example plugins](https://github.com/super-productivity/super-productivity/tree/master/packages/plugin-dev).

## Synchronization behavior

- Titles, Markdown notes, completion state, and due dates synchronize in both
  directions.
- Existing Vikunja labels can be pulled, but labels are not created or attached
  remotely.
- Project mirroring and local project assignment are pull-only.
- Deleting a local task never deletes the Vikunja task. Remote task deletion is
  not exposed by this provider.
- Subtasks are linked locally only after both tasks have been imported, and no
  placeholder local tasks are created. Verify subtask behavior on the target host
  version.
- Changing the Vikunja base URL creates a separate provider identity; existing
  links are not silently rebound to another server.
- Network failures during task creation are treated as uncertain and require
  reconciliation before retrying, to avoid accidental duplicate tasks.

## Security and data safety

Super Productivity host-side plugins are executable code, so install this plugin
only from a source you trust. Use a least-privilege Vikunja token, prefer HTTPS,
and never commit a token or production data. Back up Super Productivity data and
test first with a disposable Vikunja account.

## Development

Run the checks from the repository root:

```bash
npm test
npm run typecheck
npm run build
npm run package
```

The test suite covers API validation, pagination, mapping, field synchronization,
project paths, project discovery, import routing, hierarchy/subtasks, task
creation, label behavior, deletion safety, reliability, logging redaction,
registration, and packaging assumptions.

## License

No license has been declared for this repository yet. Add a license before
public redistribution.
