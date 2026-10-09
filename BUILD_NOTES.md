# Vikunja for Super Productivity — build and validation notes

This document describes the plugin's release artifact, reproducible build,
runtime behavior, and validation status. User-oriented setup
instructions are available in [README.md](README.md).

## Project and release

| Field | Value |
| --- | --- |
| Plugin ID | `vikunja-super-productivity-plugin` |
| Display name | `Vikunja` |
| Current version | `0.1.5` |
| Minimum Super Productivity version | `18.19.0` |
| Plugin type | `issueProvider` |
| License | MIT |
| Release tag | [`v0.1.5`](https://github.com/abhilesh/sp-vikunja/releases/tag/v0.1.5) |
| Source repository | [`abhilesh/sp-vikunja`](https://github.com/abhilesh/sp-vikunja) |

The installable artifact is:

```text
dist/vikunja-super-productivity-plugin-0.1.5.zip
```

The archive is generated output and is not committed to Git. It is attached to
the GitHub release and can also be rebuilt from a clean checkout.

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
dist/vikunja-super-productivity-plugin-0.1.5.zip
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
  available in Super Productivity 19.1.0. Project placement is updated
  separately. Older hosts that do not expose this method retain the tasks but
  cannot apply the local hierarchy.
- Ambiguous or cyclic relationships are ignored safely; placeholder tasks are
  not created.

### Recurring tasks

Vikunja remains the recurrence owner. The plugin retains Vikunja recurrence
metadata, sends completion state back to Vikunja, and maps the next due date and
open state back during the next poll.

If Vikunja reopens a task whose local Super Productivity copy has been archived,
the plugin matches the existing remote issue ID and is designed to show a
reminder to restore the task from Worklog. It does not create a synthetic
occurrence or a duplicate local task. Hosts exposing an optional in-place
`restoreTask` capability may restore the match automatically. Native Super
Productivity Repeat should not be configured for a task that remains recurring
in Vikunja.

The final v0.1.5 working-tree package also reconciles linked tasks that remain
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

The v0.1.5 source and package were verified with the following checks:

| Check | Result |
| --- | --- |
| `npm test` | Passed: 18 test files, 155 tests |
| `npm run typecheck` | Passed for production and test TypeScript projects |
| `npm run build` | Passed; browser bundle generated with esbuild |
| `npm run package` | Passed; versioned ZIP generated |
| ZIP root-content validation | Passed: exactly `manifest.json`, `icon.svg`, and `plugin.js` |
| ZIP manifest validation | Passed: version `0.1.5`, five-minute polling, expected permissions |
| `git diff --check` | Passed for the current working tree; no commit performed |

The automated suite covers authentication, field mapping, polling contracts,
project mirroring, hierarchy updates, recurrence metadata, reopened archived
tasks, duplicate-prevention logic, retry/reconciliation behavior, and safety
boundaries. Automated tests use synthetic HTTP and host API implementations.

## Live validation status

The packaged ZIP has been exercised against a disposable Vikunja fixture through
a temporary public HTTPS endpoint on Super Productivity `19.1.0`, with
Super Productivity Sync disabled.

### Verified

- The packaged plugin installed and enabled.
- Token setup and provider configuration succeeded with a correctly scoped
  disposable token.
- The packaged ZIP reached the disposable Vikunja instance through a temporary
  HTTPS endpoint; the endpoint was shut down after testing.
- A Vikunja task was imported with its label and due date.
- Enabling the host's automatic backlog-import option imported the remaining
  active tasks into the selected local staging project.
- A fresh parent/child pair imported with the child nested under the parent,
  exercising `batchUpdateForProject()` on Super Productivity 19.1.0.
- After reinstalling the rebuilt package and restarting the disposable host,
  the parent/child relationship remained visible with the child nested beneath
  its parent. The Vikunja fixture retained the corresponding `subtask` and
  `parenttask` relation records.
- With “Preserve Vikunja project structure locally” enabled, a fresh task
  imported into the expected local project mirror; repeated searches did not
  create duplicate tasks or projects.
- A linked task changed remotely and was updated by the native polling cycle
  after a Super Productivity restart.
- Completing a linked task in Super Productivity pushed its completion state to
  Vikunja; searching for that task again did not create a second local copy.
- Completing a linked recurring task advanced the same Vikunja task to its next
  daily due date and reopened it on the server.
- After the server reopened linked recurring tasks, the rebuilt package moved
  active-but-completed local copies back into the active list and applied the
  next due dates after the host restart.
- A temporary packaged test build with a 10-second polling interval was used to
  repeat the archived recurring-task transition with automatic backlog import
  and background polling enabled. The source manifest and normal ZIP were
  restored to the five-minute interval afterward.
- The ZIP-installed plugin was blocked from reaching a localhost endpoint,
  confirming the private-network limitation for community-installed plugins.

## Known host limitations

### Startup polling workaround

The plugin retains a one-time `reInitData()` call from `onReady()` because older
hosts registered plugin providers after the native polling effect was initialized.
This is a compatibility workaround, not an additional polling loop. It can be
removed or gated after the host-side polling fix represented by Super Productivity
PR #10165 is included in a released host version.

### Archived recurring tasks

The public plugin API does not guarantee an in-place archived-task restore method
or native repeat-configuration creation. The source includes archived/reopened
task detection and warning logic, but neither the normal v0.1.5 run nor the
temporary 10-second polling run triggered that warning after the host archived
the local task. Until the host exposes a reliable restore and polling path, the
safe fallback is to restore the existing task from Worklog. The plugin must not
create a duplicate local task or synthetic recurrence ID.
