# Vikunja for Super Productivity

An issue-provider plugin that connects [Super Productivity](https://super-productivity.com/) to [Vikunja](https://vikunja.io/) through the Vikunja REST API v2.

## Features

- Search and import Vikunja tasks into Super Productivity.
- Keep links to the original Vikunja tasks.
- Synchronize titles, Markdown notes, completion state, and due dates in both directions.
- Create Vikunja tasks from Super Productivity in a configured default project.
- Search across all Vikunja projects or a selected set of projects.
- Optionally mirror selected Vikunja projects locally in Super Productivity.
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
dist/vikunja-super-productivity-plugin-0.2.0.zip
```

The archive contains only the root-level `manifest.json` and `plugin.js` files.

## Configure

1. Open the Super Productivity issue-provider configuration and select Vikunja.
2. Enter the Vikunja base URL.
3. Choose the Vikunja projects to search or mirror locally.
4. Choose the default Vikunja project for tasks created from Super Productivity.
5. Set the local project prefix. The default is `Vikunja · `; an empty value removes the prefix.
6. Use the plugin's `Set Vikunja Token` button and enter the token in the password dialog.

The token is stored in Super Productivity's local secret storage. It is not part of synced provider configuration, source files, environment files, logs, or the plugin archive. Never paste a production token into a source file or commit.

## Synchronization behavior

Remote task identity is based on the normalized Vikunja URL and numeric task ID. Changing the configured server creates a separate provider identity; existing links are not silently rebound.

The plugin synchronizes task fields conservatively:

- Title, notes, completion, and due dates support pull and push synchronization.
- Existing labels can be pulled, but labels are not automatically created or attached remotely.
- Local mirrored project names include the full Vikunja path and a stable project ID marker, so duplicate project names remain distinct.
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

The test suite covers API validation, mapping, synchronization, project paths, hierarchy/subtasks, task creation, label pull behavior, deletion safety, reliability, logging redaction, registration, and packaging assumptions.

## Verification status

Automated tests, production typechecking, bundling, packaging, archive-content checks, host-load smoke checks, and credential-pattern scans pass. The packaged archive contains only `manifest.json` and `plugin.js`.

The disposable Vikunja fixture and token were verified directly against the local API. Full live provider verification remains blocked on Super Productivity 18.19.0: its provider configuration rejects requests to both `http://localhost:3456` and `http://127.0.0.1:3456`, although the same endpoint responds successfully outside the app. To complete the live matrix, use a Super Productivity host/profile that permits the manifest's private-network provider access or expose the disposable Vikunja instance through an HTTPS endpoint reachable by the app, then repeat import, hierarchy/subtask, two-way update, restart, offline, and safety checks.

## Safety and support boundaries

The plugin intentionally does not perform remote task deletion, automatic remote label creation, or destructive API operations without an explicit reviewed feature change. Network failures and failed writes should remain recoverable so local changes can be retried.

The current automated checks and clean plugin-load checks are part of the release verification. Before relying on the integration for important production data, also perform a disposable end-to-end check covering import, nested projects, subtasks, task creation, updates in both directions, restart reconciliation, and invalid-credential/offline behavior.
