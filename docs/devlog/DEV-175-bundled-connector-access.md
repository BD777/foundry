# DEV-175 bundled connector extensions and source visibility

Status: implementation and focused verification complete in worktree
`/home/windeng/workspace/foundry-ext-e1`; not deployed or committed.

## Problem

Official connector extensions lived outside the Worker and required a git
installation path. Private extension source repositories were therefore
visible only after a person knew and installed them, and a connector could be
offered on devices or to sessions that could not read its source.

The first implementation of source visibility also revealed a diagnostics
gap: a descriptor rejected by the server disappeared silently. A canonical
HTTP header typo in OpenLark produced no page message and no server log.

## Changes

- Worker packages `extensions/` and installs an official extension by id
  without a repository or git operation.
- Installed bundled extensions are digest-compared on Worker startup and
  atomically updated while retaining `data/`.
- Git-installed extensions default to automatic six-hour updates; the owner
  can turn automatic updates off and keep the manual update action.
- Existing official Limen installations from the old git folder migrate to
  bundled while retaining profiles, bindings, expiry records, and private
  data.
- `access: {via, repository}` declares a repository gate. `repositoryAccess`
  declares which device-held connector can check it. GitHub CLI uses
  `gh api repos/{repository} --silent` under its own Foundry login.
- `requires` remains a separate gate. A connector is visible only when one
  device satisfies every network requirement and, when present, its
  repository access. Both conditions are evaluated on the same device.
- The server caches non-secret checks for 24 hours and asks online devices to
  refresh them after installs, connector login changes, catalog reads, and
  the page's explicit recheck.
- Workspace bindings and session dispatch use the same visibility result.
- Refused extension descriptors are logged and stored with the device.
  Connectors shows the device, extension, kind, and reason.
- The Worker validates server-held descriptors before installation, including
  canonical HTTP headers and the server's other server-held constraints.
- Go tests validate every descriptor under `extensions/*/`.

The design record is
[`docs/research/ext-bundled-and-access.md`](../research/ext-bundled-and-access.md).

## Verification

At 2026-11-11 15:59 CST:

- `go build ./...` passed in `apps/server`.
- `go vet ./internal/connectors ./internal/httpapi ./internal/sqlitestore` passed.
- Web and Worker `tsc --noEmit` passed.
- `go test ./internal/connectors -run 'Test(BundledExtensionDescriptorsPassServerChecks|ExtensionConnectorsAreCheckedAndStayOnTheirDevice|ConnectorVisibilityRequiresEveryGateOnTheSameDevice)$'` passed.
- `go test ./internal/sqlitestore -run '^TestDeviceConnectorVisibilityChecksAreCachedAndInvalidated$'` passed.
- `go test ./internal/httpapi -run '^TestRefusedExtensionDescriptorIsSavedWithItsDevice$'` passed.
- `node scripts/run-worker-tests.mjs -- connector-extensions.test.mjs`: 18/18 passed.
- `node --import ./test/register-bundler-resolve.mjs --test test/device-held-connectors.test.mjs`: 28/28 passed.
- After the review-driven UI adjustment, the three affected Web tests passed
  3/3 and the final Web typecheck passed.

Real Chromium used a synthetic fixture with no outbound requests. The final
review captures at 1440x900 and 390x844 light show:

- visible connector picker with the expanded restricted group reduced to
  one-line per-connector summaries;
- bundled one-click install as one row per device, including a disabled
  offline row with its reason;
- git extension auto-update switch.

The 390px runs reported `innerWidth == scrollWidth == 390` and no element
extending outside the viewport. Screenshots are under
`~/workspace/foundry/.foundry/attachments/ext-e1/` in the dev checkout's
git-ignored attachment folder.

## Migration

- OpenLark now lives at `extensions/open-lark/` and is bundled. The private
  copy was removed after copying its current manifest.
- The duplicate private Limen folder was removed.
- Limen's manifest names its old git folder as `migrationSource`; only a
  matching installed source is moved to bundled. Another source with the same
  id is not replaced.
- The migration preserves `extensions/<id>/data/`, model providers and
  defaults, workspace bindings, and connector expiry records.

## Remaining

- Merge with E2, then perform the batch deployment and acceptance in the
  integrated build.
- The real page needs at least one successful `via` connector check before a
  gated connector appears in the normal catalog on a fresh device; until
  then it is shown in the restricted group with its current check state.
