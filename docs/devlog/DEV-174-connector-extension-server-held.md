# DEV-174 · OpenLark as a declarative server-held extension

## Problem

The first OpenLark connector slice treated a private service as a built-in:
it added a public catalog entry, a Server Provider, an OpenLark-specific
gateway, an `openlark_instances` table, dedicated HTTP routes, and a Worker
adapter. Human acceptance rejected that boundary. Private connectors belong
to extensions, and a server-held extension must remain pure data.

The implementation also needs the generic capability that OpenLark exposed:
a private extension declares fields and help, probes the service, replaces a
sealed secret with a session stand-in, and allows only routes the upstream's
own route directory classifies as read.

## Decision

`ConnectorDescriptor.serverHeld` is a validated, declarative gateway:

- instance fields reuse the existing field types and add probe-backed select
  options;
- probes use JSON Pointer extraction for values, options and route catalogs;
- upstream headers and session environment values use a closed template
  language (`{field:…}`, `{secret:…}`, `{gatewayBase}`, `{standIn}`);
- secrets are valid only in upstream headers;
- the gateway permits only HTTPS public addresses, pins validated DNS results,
  refuses redirects, enforces bounded bodies/timeouts, and checks every
  request against the probed route directory;
- this slice allows only `read` routes, regardless of HTTP method.

Foundry never runs extension code for a server-held connector. OpenLark now
lives in the existing private connector repository at
`~/workspace/foundry-private-connectors/openlark/`, not in this repo and not in
a new repository.

## Data and APIs

- One instance is one generic `external_provider_apps` row plus one
  `external_accounts` row and the existing workspace binding.
- Secret fields are sealed under `external-app:<appId>:extension`.
- The generic `external_provider_apps.extension_data` column stores the
  validated descriptor snapshot, non-secret values, probe outputs/options and
  route directory.
- Management routes live under
  `/api/connectors/extensions/{kind}/instances`; daemon routes are
  `/api/connectors/extensions/{kind}/session-handle` and
  `/api/connectors/extensions/{kind}/gateway/{path...}`.
- `ExternalAccountMaterial.sessionEnvironment` carries field-rendered
  templates. Worker fills only `{gatewayBase}` and `{standIn}` after starting
  the existing loopback forwarder.

## Removal and migration

- Removed the OpenLark catalog entry, Provider, gateway, HTTP file/routes,
  Worker adapter, OpenLark contract types and tests.
- Removed `OpenLarkStore`, `store/sqlitestore` OpenLark files, the Server
  backend interface entry and all product-name branches from generic code.
- `openlark_instances` is dropped only when empty. A non-empty table stops
  startup with an explicit row count; it is not silently discarded.
- Read-only check of the current dev database
  `~/.foundry/server/foundry.db`: the table exists and has 0 rows. The
  `.xacc-stack` copy has no retired table.
- Rewrote the connector and extension docs. The OpenLark extension manifest
  and bilingual README are in the private connectors repository.

## Verification

Run in the `ext-server-held` worktree:

- contract generation and protocol build: passed;
- `go build ./...`: passed;
- `go vet` on connectors, externalaccounts, gateway, httpapi, sqlitestore and
  store: passed;
- `go test ./internal/connectors -run
'Test(ServerHeldExtension|ExtensionGateway|ExtensionSession|ExtensionConnectors)'`:
  passed;
- `go test ./internal/externalaccounts -run
'TestExtension(SSRFGuard|ProbeExtracts)'`: passed;
- `go test ./internal/sqlitestore -run
'TestRetiredOpenLarkTableDropsOnlyWhenEmpty'`: passed;
- gateway permission tests for Personal Agent read/off and read-only writes:
  passed;
- HTTP route access-rule coverage: passed;
- Worker TypeScript build: passed;
- Worker tests for connector extensions and the generic server-held session
  forwarder: 16 passed;
- the real private OpenLark manifest parses to `server_held`,
  `extension:open-lark`, 2 form steps and 3 probes.

The tests use a synthetic `acme-api` extension. No real NAS or OpenLark
instance was called, and this worktree was not committed or deployed.

## Batch check follow-up

The merged dispatch path re-derived the acting device owner from
`session.DeviceID` and omitted the explicit `deviceOwner` actor from
`SessionAccounts`. That broke both directions of the owner-only rule: the
owner's own session could lose its materials when tests or callers did not
have a persisted device owner, while bob's device could pass alice's session
device through unchecked. `SessionMaterials` now passes the actor's
`deviceOwner` to the same predicate used by built-in and extension
server-held accounts; it requires `deviceOwner == sessionOwner` and still
requires the account's owner, a bound workspace (or an allowed Assistant
package), and an available device descriptor for extension instances.
`TestSessionAccountsApplyOwnerDeviceAndWorkspaceRulesToExtensionInstances`
covers the extension instance plus the Assistant no-binding case.

The new generic session-handle route is registered in `restDecls`; the
recorded device-route count is now 14. The declarative manifest test matches
the new `declares cli or serverHeld` error. `externalaccounts` explicitly
depends on the leaf `jsonempty` package for required generated collection
types, with the reason recorded beside the module table.

Follow-up checks passed:

- `go test ./internal/httpapi -run
'TestExternalAccountDispatchCarriesGatewayHandlesOnly|TestWireDeclsCoverTheDeviceProtocol'`
- `go test ./internal/externalaccounts`
- targeted `go test ./internal/externalaccounts -run` for the owner-rule and
  extension-instance regressions
- Worker `connector-declarative.test.mjs` and
  `server-held-extension.test.mjs`
- `node scripts/audit-module-boundaries.mjs`
- Prettier `--check` on the contract, changed Worker files and audit script

## Limits

- Web slice B still needs the Private-group generic form, instance list,
  validation/revocation controls and workspace binding.
- Only public HTTPS upstreams and read routes are accepted in this slice.
- The multi-instance session picks the first material for a kind.
- OpenLark's `olk`/skill installation remains a separate device setup step.

## Acceptance Steps

1. On an updated dev server, install
   `~/workspace/foundry-private-connectors/openlark` as an extension on a
   device and open Connectors → Private → OpenLark.
2. Enter the public HTTPS OpenLark root and a token generated for
   `OPEN_LARK_AGENT_READ_TOKEN`; confirm the account choices and successful
   probe.
3. Bind the instance to a workspace and start a chat. Confirm the session
   receives `OPEN_LARK_AGENT_BASE`, a stand-in token and
   `OPEN_LARK_MCP_READ_ONLY=1`, while the real token never appears.
4. Read a catalogued read route through `olk`; confirm the request reaches
   OpenLark. Try a catalogued write route and an unknown route; both should be
   refused before upstream.
5. Revoke the instance and confirm subsequent requests are denied.

Source: inter-session request `sess_1794143153454726480`.
