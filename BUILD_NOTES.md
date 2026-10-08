# Vikunja for Super Productivity — build and handoff notes

These notes describe how the Vikunja issue-provider plugin is built, transferred,
installed, configured, tested, and finished. They intentionally contain no API
tokens or production data.

## 1. What this repository produces

The project builds the Super Productivity plugin:

- Plugin ID: `vikunja-super-productivity-plugin`
- Display name: `Vikunja`
- Release version: `0.1.4`
- Minimum Super Productivity version: `18.19.0`
- Provider type: `issueProvider`
- Source repository: `git@github.com:abhilesh/sp-vikunja.git`

The installable artifact is:

```text
dist/vikunja-super-productivity-plugin-0.1.4.zip
```

The root-level manifest field `"icon": "icon.svg"` points the plugin manager to the bundled monochrome Vikunja SVG. The `issueProvider.icon` value is `"plugin-vikunja-super-productivity-plugin-icon"`, the SVG registry name Super Productivity assigns to an uploaded plugin's bundled icon. This makes the plugin card and issue-panel icon use the same monochrome asset. The plugin-card Settings action opens the local token dialog; the Settings dialog contains the Repair and Reset maintenance actions; the token dialog uses the built-in key icon for Save/Replace and success notification.

The issue provider also sets `defaultAutoAddToBacklog: true`. This preselects
Super Productivity's native `Auto import to default project` option when the
Vikunja provider is configured. The provider implements `getNewIssuesForBacklog`, which
fetches all tasks with an empty search term and applies the same numeric project
filter and optional local project mirroring used by issue-panel search.

The archive is deliberately self-contained and contains these root-level
files:

```text
manifest.json
icon.svg
plugin.js
```

It does not contain `node_modules`, TypeScript source, tests, the Vikunja database,
or credentials.

## 2. Installing on another computer

There are two supported transfer methods.

### Method A — copy the already-built ZIP

Copy this file from the build computer to the other computer by a USB drive,
private file transfer, or another trusted method:

```text
dist/vikunja-super-productivity-plugin-0.1.4.zip
```

On the other computer:

1. Open Super Productivity.
2. Go to `Settings → Plugins → Choose Plugin File`.
3. Select `vikunja-super-productivity-plugin-0.1.4.zip`.
4. Enable/select the Vikunja issue provider if Super Productivity does not do so
   automatically.
5. Configure the provider and test the connection.

The ZIP is not committed to Git because `dist/` is ignored. A copy of the ZIP is
therefore required for this method; it cannot be recovered by cloning alone unless
it is rebuilt.

### Method B — clone and rebuild on the other computer

Install a current Node.js/npm toolchain, plus the standard `zip` command available
on the operating system, then run:

```bash
git clone git@github.com:abhilesh/sp-vikunja.git
cd sp-vikunja
npm ci
npm run package
```

The resulting file is:

```text
dist/vikunja-super-productivity-plugin-0.1.4.zip
```

Select that ZIP in Super Productivity using the same `Settings → Plugins → Choose
Plugin File` menu. `npm ci` is preferred because `package-lock.json` pins the
dependency tree.

The plugin itself is not installed with `npm install`; npm is only used to build
the browser bundle. Super Productivity installs the ZIP.

## 3. Configure each Super Productivity installation

Configuration and secrets are local to each Super Productivity installation. Repeat
these steps on every computer:

1. Open `Settings → Plugins`, select the Vikunja plugin, and click the plugin
   card's Settings action. This opens the local token dialog. The plugin does not add a permanent Connect button to the main top bar.
2. Add/select the `Vikunja` issue provider.
3. Set `Vikunja base URL` to the server base URL, for example
   `https://vikunja.example`. Do not append `/api/v2`; the plugin adds that API
   path itself. A base path already present in the URL is preserved.
4. Enter a Vikunja API token in the password dialog. The dialog reports whether a
   token is already configured on this computer and offers `Replace token` when
   one exists.
5. If a connection is attempted before a token is configured, the same dialog opens
   automatically before the request is sent.
6. Test the connection.
7. Select the Vikunja projects to search/import, or leave the project filter empty
   to include every task returned by the Vikunja task endpoint.
   Selecting a parent project includes all of its descendants, so the full
   selected Vikunja subtree is mirrored and its tasks can be routed correctly.
8. Enable `Preserve Vikunja project structure locally` to create local mirrors for
   the selected projects. Super Productivity currently exposes flat projects to
   plugins, so nested paths are represented in stable names such as
   `Parent / Child`, and imported tasks are assigned to the matching mirror.
   Remote-to-local project IDs are stored separately in local browser storage, so
   IDs do not appear in visible project names. Existing projects using the older
   `[Vikunja:<id>]` suffix are recognized and renamed without the suffix.
   If a matching local project does not exist, the 0.1.4 build asks whether to
   create the missing project(s). Choosing Skip leaves those imported tasks in the
   configured default local project.
   Skip is remembered in local browser storage, scoped by Vikunja server and
   remote project ID, so normal polling does not reopen the same prompt. A new
   missing project still prompts, and a manually-created matching mirror is used.
9. Optionally set `Local project prefix`; leave blank for no prefix, or enter `Vikunja · ` if you want a prefix.
10. Set `Default project for new tasks` if creating Vikunja tasks from Super
   Productivity is needed. This is required for task creation.
11. Expand `Advanced Config` and set `Default Super Productivity Project` first.
   The host's import checkbox is labelled `Auto import to default project
   (requires a default project)` (older versions may call it `Auto-add to
   backlog`). Leave it enabled to import all currently unlinked matching tasks.
   The 0.1.4 manifest preselects this only for newly-created providers; edit an
   existing provider and enable it manually.
12. Enable `Poll imported for changes and notify` and choose `Polling trigger`.
   `always` is the most predictable setting for the first bulk import. The host
   supplies existing linked issue IDs to its adapter, so repeated polls do not
   create duplicates.

The API token is stored under the local Super Productivity secret key
`vikunja.apiToken`. It is not included in provider configuration, source files,
`.env` files, logs, the Git repository, or the ZIP. Do not put a token in a commit
or copy a production token into test fixtures.

For normal use, prefer HTTPS. Community ZIP installations cannot rely on the
manifest's `allowPrivateNetwork` setting, so URLs such as
`http://localhost:3456` or private LAN addresses may be blocked by the host.
Use a publicly reachable HTTPS endpoint or a reverse proxy allowed by the host.

## 4. Supported behavior

### Remote task operations

- Search calls the Vikunja REST API v2 task endpoint and follows paginated results.
- Native backlog import calls `getNewIssuesForBacklog` with an empty search term,
  follows pagination, applies the configured project IDs, and returns linked issue
  summaries for the host adapter to add to the backlog.
  It excludes completed tasks and tasks belonging to archived Vikunja projects.
- `defaultAutoAddToBacklog` preselects the host's `Auto import to default project`
  option (called `Auto-add to backlog` in some older versions) for this provider.
  It can be disabled in the provider configuration when a manual search/import
  workflow is preferred.
- Native backlog import initially uses the host’s configured default local
  project. The manifest declares the `taskCreated` hook; after creation, the
  plugin moves each linked task to its mapped local Vikunja mirror.
- During provider search/backlog discovery, the plugin persists a per-server
  remote task ID → local mirror project ID map in local browser storage. This is
  needed because the native host importer can omit provider-specific
  `issueLastSyncedValues` when it creates the local task. The `taskCreated` hook
  uses the stored map when those values are missing, while still preferring the
  host-provided sync value when it is available.
- Imported issue metadata also retains the remote Vikunja project ID. If the
  host attaches that metadata after `taskCreated`, the `taskUpdate` hook retries
  routing and can resolve the remote project through the stored local-project
  mapping. This covers the staging-project race seen during bulk imports.
- Plugin startup and the `Repair Vikunja projects` action perform best-effort
  repair for active tasks whose mirror ID is available from either source. On
  hosts with a readiness callback it runs after initial data load; on older
  hosts it retries when the initial task list is empty. A task imported before
  any mapping was recorded may still need one fresh provider search or re-import.
- The manifest requests a five-minute polling interval. On hosts exposing the
  optional `reInitData()` API, the plugin calls it once from `onReady()` so the
  host's native issue-polling effect can see the provider after startup. Hosts
  without that API retain the native behavior and may require saving the
  provider configuration once to re-arm polling. The plugin does not maintain a
  second independent task-sync loop.
- Search requests expanded subtasks so relation metadata can be used locally.
- Task links use the normalized base URL and the numeric Vikunja task ID.
- Titles, Markdown descriptions/notes, completion state, and due dates synchronize
  in both directions.
- Due dates support a date-only value and an explicit UTC date-time value.
- Existing Vikunja labels are pulled with stable remote label IDs. The plugin does
  not create or attach labels remotely.
- Tasks can be created in the configured default Vikunja project.
- A network error during task creation is treated as uncertain: the plugin asks for
  reconciliation before retrying so it cannot silently create a duplicate.

### Local project and hierarchy behavior

- Project filtering uses numeric Vikunja project IDs, not project names.
- Selecting a parent project includes all descendant projects. Selecting a child
  alone mirrors only that child and its descendants.
- When mirroring is enabled, selected non-archived projects are created or renamed
  locally using their full nested path; manual searches also mirror archived projects
  when their tasks are explicitly imported. Remote-to-local project IDs are stored
  separately in local browser storage.
- Project mirroring is pull-only. The plugin does not create, rename, move, or
  delete Vikunja projects.
- Imported tasks receive the corresponding local mirrored project when available.
- Exact nested local project trees are not currently possible through the public
  plugin API because `addProject` exposes no parent-project field. The plugin
  preserves the full remote path and stable remote ID in a flat local project
  name instead.
- A child task is linked to a local parent only after both remote tasks are
  imported. The plugin uses `batchUpdateForProject()` to update the parent and
  child sides together; project placement is updated separately. Hosts without
  that optional API still receive project repair, but leave task hierarchy
  unchanged. No placeholder local tasks are created.
- Ambiguous or cyclic relations are ignored safely.
- Local project assignment and parent/child repair happen through the host's
  `taskUpdate` hook and are guarded against update loops.
- The `Repair Vikunja projects` action rechecks existing linked tasks after startup and moves any task whose stored local mirror differs from its current project.
- The repair action binds the Super Productivity `updateTask` method before using
  it from asynchronous callbacks. This is required because the host API method
  uses its `PluginAPI` receiver; extracting it would produce a misleading
  “try again after Super Productivity finishes loading” error.

### Safety boundaries

- Deleting a local task never deletes the remote Vikunja task.
- The provider does not expose a remote task deletion callback.
- A remote 404 preserves local history and keeps provider identity stable.
- Changing the configured Vikunja base URL creates a distinct provider identity;
  existing links are not silently rebound to another server.
- Network and HTTP failures are sanitized so authorization headers, tokens, and
  task content are not included in surfaced errors or structured diagnostic logs.
- Super Productivity time tracking, planning, and focus data remain local.

## 5. Repository layout

```text
manifest.json                 Super Productivity plugin metadata and permissions
icon.svg                       Vikunja monochrome icon displayed by the plugin manager
package.json                  Build, test, typecheck, and packaging scripts
package-lock.json             Locked npm dependency tree
src/plugin.ts                 Provider registration, callbacks, token UI, hooks
src/config/secrets.ts         Local secret-storage key wrapper
src/vikunja/client.ts         REST v2 URLs, pagination, validation, HTTP handling
src/vikunja/mapper.ts         Vikunja ↔ Super Productivity field conversions
src/vikunja/project-path.ts   Nested project path and stable local-name logic
src/vikunja/sync-contract.ts  Identity, conflict, retry, and deletion policy
src/vikunja/logging.ts        Safe structured logging and redaction
test/                         Unit and contract tests
README.md                     User-facing feature, install, and verification summary
vikunja-test/README.md        Disposable local fixture instructions (not release data)
dist/                         Ignored build output; not a source deliverable
```

The bundle is built from `src/plugin.ts` with esbuild as a browser-compatible IIFE.
The manifest and icon are copied into a temporary package directory, the bundle is
built there, and all three files are zipped at the archive root.

## 6. Development and verification commands

From a fresh checkout:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run package
```

Expected results for the current source:

- 17 test files pass.
- 148 tests pass.
- Production and test TypeScript projects typecheck successfully.
- The package archive contains `manifest.json`, `icon.svg`, and `plugin.js`.

Useful direct checks after packaging:

```bash
unzip -l dist/vikunja-super-productivity-plugin-0.1.4.zip
unzip -p dist/vikunja-super-productivity-plugin-0.1.4.zip manifest.json
```

Do not commit `node_modules/` or `dist/`. The source of truth for rebuilding is the
Git-tracked source, manifest, package files, and tests.

## 7. Disposable Vikunja fixture

The local development fixture is Vikunja `2.4.0` with SQLite at
`http://localhost:3456`. Its README is in `vikunja-test/README.md` and documents
the container name, setup steps, API documentation URLs, and reset procedure.

The fixture database and uploaded files are ignored by Git and must remain
disposable. Use a dedicated test account and never use production credentials or
production task data.

Typical container commands are:

```bash
docker start vikunja-test
docker stop vikunja-test
docker logs --tail 100 vikunja-test
```

## 8. Current commit and release state

At the time these notes were updated:

- The `v0.1.0` tag (`591f9d5`) is the baseline for the public release comparison.
- The working tree contains the `0.1.4` release-preparation changes; commit and tag
  them as `v0.1.4` before publishing the GitHub release. Leave `v0.1.3` unchanged.
- `dist/` is ignored, so the installable ZIP is not committed or transferred by a
  normal clone.
- `vikunja-test/README.md` is currently untracked. It is useful development
  documentation but is not required to install or run the plugin.
- A stray `.DS_Store` is untracked and is not needed.

The release archive is expected to contain exactly `manifest.json`, `icon.svg`, and `plugin.js`.
If the archive was not separately preserved, rebuild it with `npm run package` on
the destination computer.

## 9. Release validation

The code and automated verification are in good shape. Before asking for
community re-review, validate the actual `0.1.4` ZIP in a separate disposable
Super Productivity instance/profile with Super Productivity Sync disabled. Do
not use the production instance or production credentials.

The packaged ZIP has been installed and enabled in the disposable Super
Productivity 19.1.0 profile, with Sync disabled. The plugin card and Vikunja
configuration UI load correctly, but the host made no `/api/v2` request to
either `localhost` or `127.0.0.1:3456`; this confirms the community-ZIP private
network restriction. The full live matrix below remains pending a disposable
Vikunja endpoint that is publicly reachable over HTTPS (or otherwise allowed
by the host).

1. Expose the disposable Vikunja instance through a publicly reachable HTTPS
   endpoint or another address allowed by the Super Productivity host.
2. Install the 0.1.4 ZIP into the disposable host.
3. Run the live matrix with disposable data:
   - plugin-card token setup, connection test, and invalid-token behavior;
   - plugin-card Settings token setup; confirm no Connect action appears in the main top bar and Repair/Reset appear in the Vikunja Settings dialog;
   - bulk import with an empty project filter, selected-project filtering, and
     repeat-poll deduplication;
   - search/import and project filtering;
   - nested project mirroring and project rename reconciliation;
   - parent/subtask linking when both tasks are imported;
   - title, Markdown description, completion, and due-date updates in both
     directions;
   - task creation and manual reconciliation after an intentionally interrupted
     network response;
   - restart/reconciliation behavior;
   - offline/network failure behavior;
   - deletion-safety and duplicate-name checks.
4. Preserve the final ZIP outside `dist/` if the test computer must install it
   without having Node.js/npm available.

Do not expand the safety boundaries—remote deletion, automatic remote label
creation, or destructive API operations—without a separately reviewed feature
change and new tests.
