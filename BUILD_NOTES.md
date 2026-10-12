# Vikunja for Super Productivity — build and validation notes

This document describes the plugin's release artifact, reproducible build,
runtime behavior, and validation status. User-oriented setup
instructions are available in [README.md](README.md).

## Project and release

| Field | Value |
| --- | --- |
| Plugin ID | `vikunja-super-productivity-plugin` |
| Display name | `Vikunja` |
| Current version | `0.2.0` |
| Minimum Super Productivity version | `19.2.0` |
| Plugin type | `issueProvider` |
| License | MIT |
| Release tag | [`v0.2.0`](https://github.com/abhilesh/sp-vikunja/releases/tag/v0.2.0) |
| Source repository | [`abhilesh/sp-vikunja`](https://github.com/abhilesh/sp-vikunja) |

The installable artifact is:

```text
dist/vikunja-super-productivity-plugin-0.2.0.zip
```

## Artifact and runtime model

The ZIP contains exactly these files at its root:

```text
manifest.json
icon.svg
plugin.js
```

The bundle is a browser-compatible IIFE generated from `src/plugin.ts` with
esbuild. It does not include source files, tests, `node_modules`, credentials,
or a Vikunja database.

The plugin runs in the Super Productivity host renderer (`iFrame: false`) and
uses the host issue-provider HTTP client for Vikunja REST API v2 requests. It
does not run a second independent polling loop. The manifest requests the
host's native five-minute issue-provider polling interval and sets
`defaultAutoAddToBacklog: true` for newly-created providers.

## Reproducible build

Requirements:

- Node.js and npm
- The standard `zip` command

From a clean checkout:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run package
```

The package command creates:

```text
dist/vikunja-super-productivity-plugin-0.2.0.zip
```

## Installation and configuration

Install the ZIP through Super Productivity:

1. Open `Settings → Plugins → Choose Plugin File`.
2. Select the versioned Vikunja ZIP.
3. Enable the Vikunja issue provider if required.
4. Configure the provider as described in [README.md](README.md).

Configuration is local to each Super Productivity installation. The Vikunja
API token is stored in Super Productivity secret storage under
`vikunja.apiToken`; it is not placed in provider configuration, source files,
logs, or the release archive.

For automatic backlog import, configure a default Super Productivity staging
project in `Advanced Config` and enable the host option named `Auto import to
default project` (older hosts may call it `Auto-add to backlog`). For imported
task polling, enable `Poll imported for changes and notify` and choose the
desired polling trigger.

## Network and security requirements

Use a least-privilege Vikunja API token and prefer HTTPS. For ZIP-installed
community plugins, Super Productivity hosts may ignore the manifest's
`allowPrivateNetwork` setting. A Vikunja server on `localhost` or a private LAN
address may therefore be blocked. Use a publicly reachable HTTPS endpoint or a
reverse proxy permitted by the host.

The plugin does not log authorization headers or API tokens. Local task-to-
Vikunja mappings are kept in browser storage and are scoped by provider/server
identity. Changing the configured base URL creates a distinct provider
identity; existing links are not silently rebound to another server.

## Supported behavior

### Tasks and synchronization

- Search and import Vikunja tasks through the Super Productivity issue panel.
- Import active, unlinked tasks through the host's native backlog-import flow.
- Synchronize titles, Markdown notes, completion state, and due dates in both
  directions.
- Create new Vikunja tasks in the configured default remote project.
- Pull existing Vikunja labels without creating or attaching labels remotely.
- Treat uncertain task-creation responses as requiring reconciliation before a
  retry, reducing the risk of duplicate remote tasks.
- Never delete a remote Vikunja task when a local Super Productivity task is
  deleted.

### Projects and hierarchy

- Filter by numeric Vikunja project IDs rather than project names.
- Selecting a parent project includes its descendants.
- Project mirroring is pull-only; the plugin does not create, rename, move, or
  delete projects in Vikunja.
- Missing local mirrors prompt before creation. A skipped decision is remembered
  per server and remote project ID.
- Because the public Super Productivity API does not expose parent-project
  creation, nested remote paths are represented as stable flat local names such
  as `Parent / Child`.
- Imported parent/child tasks are linked with `batchUpdateForProject()`, which is
  available in the required Super Productivity 19.2.0 host line. Project
  placement is updated separately.
- Ambiguous or cyclic relationships are ignored safely; placeholder tasks are
  not created.

### Recurring tasks

Vikunja remains the recurrence owner. The plugin retains Vikunja recurrence
metadata, sends completion state back to Vikunja, and maps the next due date and
open state back during the next poll.

If Vikunja reopens a task whose local Super Productivity copy has been archived,
the plugin matches the existing remote issue ID and does not create a synthetic
occurrence or a duplicate local task. The public host API does not guarantee an
in-place restore operation, so the existing task may need to be restored from
Worklog manually. Hosts exposing an optional in-place `restoreTask` capability
may restore the match automatically. Native Super Productivity Repeat should
not be configured for a task that remains recurring in Vikunja.

The v0.2.0 package also reconciles linked tasks that remain
active but locally completed. This path explicitly reopens the local task and
applies Vikunja's next due date during the provider poll. The host API methods
are bound before use because Super Productivity exposes them through a
class-backed bridge.

The archived-task path remains host-dependent. In the disposable live run,
Vikunja correctly reopened a daily recurring task, but Super Productivity did
not emit the reminder or automatically reopen the archived local copy, even
with a temporary 10-second polling build. Until the host exposes a reliable
restore and polling path, restore the existing task manually from Worklog rather
than importing a second copy.

## Source layout

```text
manifest.json                 Plugin metadata and host permissions
icon.svg                      Bundled monochrome Vikunja icon
package.json                  Build, test, typecheck, and packaging scripts
package-lock.json             Locked npm dependency tree
src/plugin.ts                 Provider registration, callbacks, and token UI
src/config/secrets.ts         Secret-storage key wrapper
src/vikunja/client.ts         REST v2 URLs, pagination, and HTTP handling
src/vikunja/mapper.ts         Vikunja ↔ Super Productivity field mapping
src/vikunja/project-path.ts   Stable local names for remote project paths
src/vikunja/reopened-tasks.ts Archived/reopened recurring-task classification
src/vikunja/sync-contract.ts  Identity, conflict, retry, and deletion policy
src/vikunja/logging.ts        Structured logging and redaction
test/                         Unit and contract tests
README.md                     User-facing installation and usage guide
BUILD_NOTES.md                Public build and validation record
LICENSE                       MIT license text
dist/                         Ignored local build output
```

## Automated verification

The v0.2.0 source and package were verified with the following checks:

| Check | Result |
| --- | --- |
| `npm test` | Passed: 18 test files, 156 tests |
| `npm run typecheck` | Passed for production and test TypeScript projects |
| `npm run build` | Passed; browser bundle generated with esbuild |
| `npm run package` | Passed; versioned ZIP generated |
| ZIP root-content validation | Passed: exactly `manifest.json`, `icon.svg`, and `plugin.js` |
| ZIP manifest validation | Passed: version `0.2.0`, minimum host `19.2.0`, five-minute polling, expected permissions |
| `git diff --check` | Passed: no whitespace errors in the release diff |

The automated suite covers authentication, field mapping, polling contracts,
project mirroring, hierarchy updates, recurrence metadata, reopened archived
tasks, duplicate-prevention logic, retry/reconciliation behavior, and safety
boundaries. Automated tests use synthetic HTTP and host API implementations.

## Live validation status

The packaged v0.2.0 ZIP was installed and tested in a disposable Super
Productivity 19.2.0 profile against a disposable Vikunja instance exposed over
public HTTPS. Super Productivity Sync was disabled.

The live run passed the following checks:

- token setup and HTTPS connectivity;
- import through the packaged ZIP;
- Super Productivity-to-Vikunja completion updates;
- automatic polling after a Super Productivity restart without resaving the
  provider configuration;
- project mirroring with one local mirror and no duplicate project;
- parent/child task nesting;
- Vikunja-owned recurrence, including reopening the task and importing its next
  due date during the unattended background poll.

For background polling, the host must be configured with a default Super
Productivity staging project and `Always (in background)` as the polling
trigger. With `When context is open` and no default project, the host does not
request the automatic backlog poll; this is host configuration rather than a
plugin failure.

## Host compatibility

Super Productivity 19.2.0 or newer is required. Starting with v19.2, the host
rebuilds issue-provider polling when a plugin registers after the initial sync.
The plugin therefore relies on the host's native polling path and does not
replay application initialization or require provider settings to be saved
again after a restart.

### Archived recurring tasks

The public plugin API does not guarantee an in-place archived-task restore method
or native repeat-configuration creation. The source includes archived/reopened
task detection and warning logic, but the live runs did not reliably trigger a
warning or restore the archived local copy after Vikunja reopened it. Until the
host exposes a reliable restore and polling path, the safe fallback is to
restore the existing task from Worklog. The plugin must not create a duplicate
local task or synthetic recurrence ID.
