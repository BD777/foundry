# Bundled extensions and connector-mediated source access

This note records the E1 design for shipping official connector extensions
with the Worker and for deciding whether a connector is visible from the
device's existing Foundry connector logins.

## Goals

- An extension in `extensions/` is unpacked with the Worker and installs on a
  device without a repository URL or a git checkout.
- An installed bundled extension updates with the Worker by digest comparison.
- A git-installed extension updates automatically every six hours by default,
  and its owner can turn that off.
- A gated connector is visible only when, on the same device, every declared
  network requirement is met and the named Foundry connector can read its
  source repository. At least one of the owner's devices must satisfy both.
- Workspace binding, connector choices, and session dispatch never expose a
  connector that fails that visibility rule.
- Existing git-installed Limen installations become bundled without losing
  their extension data, model profiles, bindings, or expiry records.

## Data shapes

Static connector descriptor:

```ts
interface ConnectorSourceAccess {
  via: string; // connector kind with repositoryAccess
  repository: string; // owner/repo or an https repository URL
  hint?: string;
  hints?: Record<string, string>;
}

interface ConnectorRepositoryAccess {
  args: string[]; // argv template; {repository} is the only input
  repositoryFormat?: "raw" | "github";
}

interface ConnectorDescriptor {
  access?: ConnectorSourceAccess;
  repositoryAccess?: ConnectorRepositoryAccess;
  // Filled by the Worker from its cached checks, never authored in a manifest:
  accessCheck?: ConnectorSourceAccessCheck;
  requirementsCheck?: ConnectorRequirementsCheck;
}
```

GitHub CLI declares `repositoryAccess` with
`["api", "repos/{repository}", "--silent"]` and
`repositoryFormat: "github"`. That capability is available to a descriptor
whose `access.via` is `"github"`. The server validates the relationship
against the descriptors reported on the same device; a missing or unknown
`via` is invalid.

Runtime check results:

```ts
type SourceAccessStatus =
  "ok" | "no_access" | "not_signed_in" | "unreachable" | "error";

interface ConnectorSourceAccessCheck {
  status: SourceAccessStatus;
  checkedAt: string;
  identity?: string; // the Foundry connector account used
  detail?: string; // short, non-secret tool message
}

interface ConnectorRequirementsCheck {
  ok: boolean;
  checkedAt: string;
  requirement?: string; // first failed requirement label
}
```

Extension source data adds:

```ts
interface ConnectorExtensionSource {
  bundled?: boolean;
  state?: "installed" | "available";
  autoUpdate?: boolean; // git-installed extensions; default true
  source?: ConnectorExtensionRepository;
  commit?: string;
  latestCommit?: string;
}
```

An absent `state` means `installed`, so descriptors from older Workers keep
their current meaning. A bundled extension that is present in the Worker but
not installed is reported with `state: "available"`; it can appear in the
catalog but cannot back a device connector or session until installed.

The registration also carries `extensionErrors` after server validation:

```ts
interface ConnectorExtensionError {
  extensionId: string;
  extensionName: string;
  kind: string;
  reason: string;
}
```

Every refused descriptor is logged with the device and kept on the device
record. The Connectors page shows the extension name, device, and reason
rather than dropping it silently.

`ConnectorCatalogView` keeps user-visible connectors in `connectors` and adds
`restrictedConnectors`. Each restricted item contains its descriptor and one
check per owner device: device name, online state, status, `via`, account,
short detail, requirement label, and checked time.

## Access check

Repository access is checked by the connector named in `access.via`, not by
the source repository's git transport:

1. Resolve the `via` descriptor among the built-in catalog and descriptors
   reported by the device. It must be device-held and declare
   `repositoryAccess`.
2. Read that connector's Foundry status. If it is missing or not signed in,
   record `not_signed_in`.
3. Run the provider's argv template with its normal Foundry runner and the
   active Foundry-managed login. No shell is used. GitHub URLs are normalized
   to `owner/repo` before substitution.
4. Exit zero is `ok`. Authentication/permission/not-found answers are
   `no_access`; DNS/connect/timeout answers are `unreachable`; anything else
   is `error`.

The result carries the connector account's non-secret identity. The server
caches it by `(device, via, repository)` for 24 hours. Requirement checks use
the same table, keyed by the connector and its requirement declaration. A
GitHub CLI login change, an extension install/update, or an explicit "check
again" invalidates the affected rows. The Connectors catalog starts stale
checks on online owner devices, waits briefly, and returns the cached result
while slower checks continue in the background.

`tcp_reachable` requirements are always a visibility gate, whether or not a
repository check also exists. The Worker checks each requirement on the same
device as the connector login and reports the first failed label. A connector
is visible when at least one owner device meets every requirement and, when
`access` is present, also reads its repository. Bytedcli uses its existing
network requirement and needs no repository access declaration until a
connector can check its repository host.

## Refresh and update timing

- Worker startup scans bundled extension directories. Installed bundled
  extensions are compared by SHA-256 and replaced when the Worker's copy
  changes; their `data/` folder is never touched.
- An installed bundled extension is not auto-installed on devices that did
  not choose it. Those devices see "Install on this device."
- Git-installed extensions default `autoUpdate: true`. The existing six-hour
  source check updates them atomically when the upstream commit changes.
  Turning auto-update off keeps the commit check and manual Update action.
- Bundled extension availability is refreshed on Worker startup. The server
  refreshes network and repository checks when it loads the Connectors
  catalog, and installation, update, GitHub login changes, and the page's
  "Check again" trigger a forced refresh.

## Page behavior

- The picker keeps public and private visible groups.
- Its bottom `Needs access` group is collapsed by default. Each connector is
  one summary row, such as "2 devices do not meet the conditions". Selecting
  it closes the picker and shows the complete per-device explanation in the
  page body. A GitHub result says which account Foundry used and links to
  Connectors > GitHub CLI so the person can switch accounts.
- A restricted connector lists every unmet condition separately. Network copy
  is generic and generated only from the descriptor: "Needs to reach {label}
  ({host}:{port}). None of your devices can connect; use this on a device on
  that network." Repository copy is generated from the connector name,
  repository, and account, never from hard-coded product names.
- The group has one "Check again" action. It asks every online device to
  refresh the relevant access checks and reloads the catalog.
- When no device has a bundled extension, the empty state becomes one row per
  device with a direct "Install on this device" action. Offline or ineligible
  devices stay visible with the reason their action is disabled. A
  git-installed extension keeps the existing repository confirmation dialog.
- Installed extension actions include an Auto-update switch for git sources,
  on by default. Bundled extensions state that they update with the Worker.

## Migration

The private OpenLark folder moves byte-for-byte into
`extensions/open-lark/`; its account extractors remain `/id` and `/name`.
The duplicate private Limen copy is removed.

On startup, an installed extension whose id is bundled migrates when its
recorded source is the official Foundry repository folder for that extension
(for Limen, `https://github.com/BD777/foundry.git` and
`extensions/limen`). Migration installs the bundled files with
`bundled: true`, clears the git source/commit, and retains:

- `extensions/<id>/data/`;
- all external profiles and their defaults;
- workspace bindings and connector expiry records;
- the extension id and connector kind.

Any other source with the same id is left alone and is not silently replaced.
If the bundled copy is unchanged, migration only rewrites the source metadata.
If it changed, the normal atomic extension update replaces `current/`.
