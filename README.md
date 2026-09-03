# Vikunja for Super Productivity

An issue-provider plugin that connects [Super Productivity](https://super-productivity.com/) to [Vikunja](https://vikunja.io/) through the Vikunja REST API v2.

## Features

- Search and import Vikunja tasks into Super Productivity.
- Import all matching Vikunja tasks through Super Productivity's native backlog-import flow.
- Keep links to the original Vikunja tasks.
- Synchronize titles, Markdown notes, completion state, and due dates in both directions.
- Create Vikunja tasks from Super Productivity in a configured default project.
- Search across all Vikunja projects or a selected set of projects.
- Optionally preserve selected Vikunja project paths in local Super Productivity project mirrors.
- Mirror nested project paths locally with a configurable prefix.
- Pull existing Vikunja labels without creating or pushing labels remotely.
- Pull-link subtasks when both the parent and child have been imported.
- Keep Super Productivity time tracking, planning, and focus data local.

Vikunja remains the source of truth for remote task-management fields. Local project mirroring and hierarchy synchronization are pull-only: the plugin does not create, rename, move, or delete Vikunja projects.

## Requirements

- Super Productivity 18.19.0 or newer.
- A Vikunja server with REST API v2 enabled.
- A Vikunja API token with access to the projects and tasks you want to use.

Use an HTTPS Vikunja URL for normal use. Local HTTP servers require the host's private-network plugin policy to permit access.

## Install

Build the self-contained plugin package:

```bash
npm install
npm run package
```

In Super Productivity, open `Settings → Plugins → Choose Plugin File` and select:

```text
dist/vikunja-super-productivity-plugin-0.3.13.zip
```

The archive contains the root-level `manifest.json`, `icon.svg`, and `plugin.js` files.
The plugin card and issue panel use the bundled monochrome Vikunja SVG, and the
`Connect Vikunja` button uses the built-in `settings` icon.

## Configure

1. Open `Settings → Plugins`, select the Vikunja plugin, and use its plugin-card
   Settings action to open the token dialog. The top-bar `Connect Vikunja` button
   remains available as a quick shortcut.
2. Enter the Vikunja base URL in the issue-provider configuration.
3. Choose the Vikunja projects to import/search, or leave the selector empty for all accessible tasks.
4. Choose the default Vikunja project for tasks created from Super Productivity.
5. Set the local project prefix. Leave blank for no prefix, or enter `Vikunja · ` if you want a prefix.
6. Expand `Advanced Config` in the provider edit screen. First set
   `Default Super Productivity Project`; then enable `Auto import to default
   project (requires a default project)` if it is not already selected. Vikunja
   0.3.13 preselects this native Super Productivity option only when a new
   provider is created; existing Vikunja providers must be edited once.
   If a connection is attempted before a token is configured, this dialog opens automatically.

### Import all Vikunja tasks

To import every active task, leave `Vikunja projects to import/search` empty
and enable `Auto import to default project (requires a default project)` under
`Advanced Config`. (Older Super Productivity versions may call this `Auto-add to
backlog`.) Super Productivity then calls the provider's bulk callback
with an empty search term, follows Vikunja pagination, and imports only remote
tasks that are not already linked locally. Completed tasks and tasks in archived
Vikunja projects are excluded from automatic import. To import only selected projects, choose their numeric IDs in `Vikunja projects to import/search` first. Selecting a parent project includes all of its descendants. Enable
`Poll imported for changes and notify` and choose the desired `Polling trigger`
(`always` is the most predictable first-import setting). The host then runs the
bulk import during its normal provider polling cycle.

Enable `Preserve Vikunja project structure locally` to create local project
mirrors and assign imported tasks to them. Super Productivity's plugin API does
not currently expose parent-project creation, so a nested Vikunja path is kept as
a stable flat name such as `Parent / Child`; the remote project hierarchy is not
modified. Local project mappings are stored separately on this computer, so
Vikunja IDs do not appear in project names. The 0.3.13 build asks before creating missing local mirror projects; choosing
Skip leaves those imported tasks in the configured default local project.
Choosing `Skip` is remembered locally for each missing Vikunja project and
server, so the same prompt does not reappear during normal polling. A newly
missing project still gets its own prompt. If you later create the matching
local mirror manually, its project name is detected and routing resumes.
Use `Reset Vikunja project prompt decisions` in the top bar if you want to review a skipped project again.
If tasks were imported before routing was available, or if startup happened before the task list finished loading, use the `Repair Vikunja projects` action in the Super Productivity top bar after the app is ready. It rechecks stored destination metadata and moves existing linked tasks without re-importing them.

The native importer may briefly create a task in the configured default local
project. The plugin records the remote task-to-mirror mapping during discovery
and immediately moves the task after the host's `taskCreated` event, including
when the host omits the provider-specific sync metadata.

This is a linked issue import, not a one-way copy: imported tasks retain their
Vikunja issue identity and the configured title, notes, completion, and due-date
field synchronization. The plugin does not delete local tasks or remote Vikunja
tasks during the import.

The token is stored in Super Productivity's local secret storage. It is not part of synced provider configuration, source files, environment files, logs, or the plugin archive. Never paste a production token into a source file or commit.

## Synchronization behavior

Remote task identity is based on the normalized Vikunja URL and numeric task ID. Changing the configured server creates a separate provider identity; existing links are not silently rebound.

The plugin synchronizes task fields conservatively:

- Title, notes, completion, and due dates support pull and push synchronization.
- Existing labels can be pulled, but labels are not automatically created or attached remotely.
- Local mirrored project names include the full Vikunja path. Remote-to-local project IDs are stored separately on the computer running the plugin.
- Subtasks are linked locally only after both remote tasks have been imported. The plugin does not create placeholder tasks.
- Deleting a local task never deletes the Vikunja task. Remote deletion is not exposed by the provider.
- Remote project changes do not rename or delete local execution data.

Back up your Super Productivity data before enabling a new plugin, and validate the integration with a disposable Vikunja account before connecting a production account.

## Development

Run the automated checks:

```bash
npm test
npm run typecheck
npm run build
npm run package
```

The test suite covers API validation, mapping, synchronization, project paths, hierarchy/subtasks, task creation, label pull behavior, native bulk import, deletion safety, reliability, logging redaction, registration, and packaging assumptions.

## Verification status

Automated tests, production typechecking, bundling, packaging, archive-content checks, host-load smoke checks, and credential-pattern scans pass. The packaged archive contains `manifest.json`, `icon.svg`, and `plugin.js`.

The disposable Vikunja fixture and token were verified directly against the local API. Full live provider verification remains blocked on Super Productivity 18.19.0: its provider configuration rejects requests to both `http://localhost:3456` and `http://127.0.0.1:3456`, although the same endpoint responds successfully outside the app. To complete the live matrix, use a Super Productivity host/profile that permits the manifest's private-network provider access or expose the disposable Vikunja instance through an HTTPS endpoint reachable by the app, then repeat import, hierarchy/subtask, two-way update, restart, offline, and safety checks.

## Safety and support boundaries

The plugin intentionally does not perform remote task deletion, automatic remote label creation, or destructive API operations without an explicit reviewed feature change. Network failures and failed writes should remain recoverable so local changes can be retried.

The current automated checks and clean plugin-load checks are part of the release verification. Before relying on the integration for important production data, also perform a disposable end-to-end check covering import, nested projects, subtasks, task creation, updates in both directions, restart reconciliation, and invalid-credential/offline behavior.
