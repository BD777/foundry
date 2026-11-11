# Server-held connector extensions

## Decision

Connector extensions may now declare a **server-held** connector when the
declaration is pure data. Foundry keeps the credential, probes the upstream,
injects a revocable stand-in into a session, and proxies requests through the
common gateway. Server code never loads or runs extension code for a
server-held connector.

OpenLark becomes one such extension. Its built-in catalog entry, provider,
gateway, routes, storage, Worker adapter, contract types and Web form are
removed. The OpenLark extension lives outside this repository in the existing
private connector repository at
`~/workspace/foundry-private-connectors/openlark/`.

## Descriptor

`ConnectorDescriptor` gains an optional `serverHeld` object. It is valid only
when:

- the descriptor comes from an installed extension;
- `holding` is `server_held`;
- the adapter is `extension:<extension-id>`;
- `signIn` is absent (server-held instances use `serverHeld.fields`);
- the descriptor is owner-visible and accepted by the existing extension
  descriptor checks.

The final data shape is:

```jsonc
{
  "holding": "server_held",
  "serverHeld": {
    "instances": "many",
    "fields": [
      {
        "id": "baseUrl",
        "type": "url",
        "required": true,
        "label": "Server URL",
        "labels": { "zh-CN": "服务地址" },
        "help": "The HTTPS root ...",
        "helps": { "zh-CN": "..." },
      },
      {
        "id": "readToken",
        "type": "secret",
        "required": true,
        "label": "Agent token",
      },
      {
        "id": "account",
        "type": "select",
        "required": false,
        "optionsFrom": "probe:accounts",
      },
    ],
    "steps": [["baseUrl", "readToken"], ["account"]],
    "probe": [
      {
        "id": "capabilities",
        "method": "GET",
        "path": "/agent/v1/capabilities",
        "optional": true,
        "extract": {
          "values": {
            "version": "/version",
            "scope": "/token/scope",
          },
          "options": {
            "items": "/accounts",
            "value": "/id",
            "label": "/name",
          },
        },
      },
      {
        "id": "routes",
        "method": "GET",
        "path": "/agent/v1/",
        "extract": {
          "routes": {
            "items": "/routes",
            "method": "/method",
            "path": "/path",
            "access": "/access",
            "domain": "/domain",
          },
        },
      },
    ],
    "upstream": {
      "baseField": "baseUrl",
      "pathPrefix": "/agent/v1",
      "headers": {
        "Authorization": "Bearer {secret:readToken}",
        "x-example-account": "{field:account}",
      },
      "requestBodyLimitBytes": 8388608,
      "responseBodyLimitBytes": 16777216,
      "timeoutSeconds": 60,
    },
    "access": {
      "from": "probe:routes",
      "default": "deny",
      "allowBy": {
        "value": "probe:capabilities/scope",
        "map": {
          "full": ["read", "write"],
          "read": ["read"],
        },
        "otherwise": ["read"],
      },
    },
    "session": {
      "env": {
        "EXAMPLE_BASE": "{gatewayBase}",
        "EXAMPLE_TOKEN": "{standIn}",
        "EXAMPLE_READ_ONLY": "{probeMap:capabilities/scope|full=0|*=1}",
      },
    },
    "network": { "publicOnly": true },
  },
}
```

Rules:

- Probe and route JSON pointers use RFC 6901 pointers rooted at the JSON
  document (`""` is the root, `/routes` is an object member).
- A probe may be `optional`; a 404 skips it. Required probes must succeed.
- `optionsFrom` names a probe id. A select field has either static `options`
  or `optionsFrom`, never both.
- `steps` is presentation data for Web. Every id must name a declared field;
  no field may be repeated. The server does not require every optional field
  to appear in a step.
- `access.from` names a probe whose `extract.routes` produced the route
  directory. Unknown/missing routes deny. Exactly one of `allow` and
  `allowBy` is present.
- `allow` is the fixed set of route levels a saved descriptor grants.
- `allowBy.value` is `probe:<probe-id>/<extracted-name>`; the probe value is
  looked up in `allowBy.map`, falling back to `allowBy.otherwise`. The chosen
  levels are `read`, `write`, or both. Validation records the scope, and the
  gateway compares each route's catalogued `access` with the resulting level.
  Assistant writes use the permission package, refuse at `read`, and require
  the existing confirmation flow at `write`. Other sessions do not ask for an
  assistant confirmation.
- `network.publicOnly` must be `true` in this slice. That means HTTPS,
  public-unicast destinations only, DNS resolved before connecting, the
  dialer pinned to a validated IP, and redirects refused.
- `network.holdings` declares whether instances may use the `server`, `device`
  or both network paths. `publicOnly` constrains only the server path: HTTPS,
  public-unicast destinations, DNS resolved before connecting, the dialer
  pinned to a validated IP, and redirects refused.
- A device-path instance validates through the selected online device and
  records the owner's other reachable devices. The server links every
  request through the session device; its gateway still authenticates,
  classifies, audits and injects the sealed credential, while the device
  performs the upstream HTTP exchange.
- Request/response limits and the timeout are bounded by server defaults.
  A descriptor can lower them, but not raise them above 8 MiB, 16 MiB and
  60 seconds.

### Templates

Only these references are accepted:

- `{field:<field-id>}`;
- `{secret:<field-id>}`;
- `{probeMap:<probe-id>/<extracted-name>|match=value|*=default}`;
- `{gatewayBase}`;
- `{standIn}`.

Secrets are accepted only in `upstream.headers`. They are rejected in
`session.env`, probe paths, URLs and field values. `probeMap` is accepted only
in `session.env` and is rendered on the Server from the probe value recorded
with the instance. A header whose only value is a reference to an empty field
is omitted. `session.env` renders field and `probeMap` references on the
Server; `{gatewayBase}` and `{standIn}` are left for Worker, which knows the
loopback port and live stand-in.

## Persistence

No connector-specific table is introduced.

- One instance is one generic `external_provider_apps` row:
  `provider` is the extension kind, `owner_user_id` is the person,
  `created_via` is `extension`, `label` and `base_url` are display metadata.
- The selected workspace-visible identity is one generic
  `external_accounts` row, with `mode = server_held` and the normal
  `external_account_bindings` row.
- Secret fields are sealed as one JSON map under
  `external-app:<app-id>:extension`; replacing an instance with a blank
  secret keeps the sealed value.
- Validated descriptor snapshot, non-secret field values, last probe
  values/options/route directory and status metadata live in a new generic
  `external_provider_apps.extension_data` JSON column. This keeps an instance
  usable when a different owned device is online while still binding the
  instance to the descriptor version it was validated against.
- Audit continues through `external_account_events` with the generic kind
  `extension_connector_request`, never a credential.

The `openlark_instances` table is removed once its row count is zero. A
non-empty table stops migration with an explicit error rather than silently
discarding data.

## Module boundaries

- `internal/connectors/descriptor_checks.go` owns descriptor validation,
  including template references, probes, path prefixes, route extraction,
  environment names and bounded transport settings.
- `internal/externalaccounts/extension*.go` owns generic instance CRUD,
  sealed fields, probing, provider-app/account projection and secret
  substitution. It has no extension-kind branches.
- `internal/connectors/extension_gateway.go` owns the generic
  `gateway.Pipeline` provider: it classifies against the stored route
  directory, injects headers, limits bodies, proxies, refuses and audits.
- `internal/httpapi/connector_extensions*.go` owns the generic routes. It
  resolves the descriptor only from extensions reported by the signed-in
  person's own devices.
- `connectors.Module` exposes extension descriptors through
  `CatalogFor`, routes unknown server-held accounts to the generic handle
  issuer, and only dispatches an extension account to a session on a device
  that reports the same connector kind and tool.
- Worker validates `serverHeld` in the manifest and keeps it in the reported
  descriptor. For sessions, it starts the existing loopback
  `gateway-forwarder` for each generic extension material, renders
  `{gatewayBase}` and `{standIn}`, renews the handle through the generic
  session-handle route, and releases the forwarder at session end.

## API

All routes are person-only for management and daemon-only for session traffic.
`kind` must be a server-held extension connector reported by one of the
caller's devices.

- `GET /api/connectors/extensions/{kind}/instances`
  returns `{ kind, descriptor, instances }`.
- `POST /api/connectors/extensions/{kind}/instances/probe`
  takes `{ label?, fields }`, validates and probes without persisting, and
  returns normalized non-secret values, secret field ids, probe values,
  field options and route count.
- `POST /api/connectors/extensions/{kind}/instances`
  probes, seals, creates the generic app/account and returns the instance.
- `PUT /api/connectors/extensions/{kind}/instances/{instanceId}`
  re-probes and replaces non-secret values and any supplied secrets.
- `POST /api/connectors/extensions/{kind}/instances/{instanceId}/check`
  re-probes a saved instance.
- `DELETE /api/connectors/extensions/{kind}/instances/{instanceId}`
  deletes the sealed fields and marks the account revoked.
- `POST /api/connectors/extensions/{kind}/session-handle`
  issues a fresh 30-minute stand-in for a live session and account.
- `GET|POST|PATCH|PUT|DELETE
/api/connectors/extensions/{kind}/gateway/{path...}`
  proxies through the common pipeline.

Existing external-account binding routes bind `instance.accountId` to a
workspace. Web B does not need a new binding API.

### Types for slice B

- `ConnectorServerHeld`: `instances`, `fields`, `steps`, `probe`, `upstream`,
  `access`, `session`, `network`.
- `ConnectorServerHeldField`: the descriptor's field shape plus
  `optionsFrom`.
- `ConnectorServerHeldProbe`: id, method, path, optional, JSON-pointer
  extraction.
- `ConnectorServerHeldInstance`: id, accountId, kind, label, status,
  statusDetail, version, routeCount, values, secretFields, fieldOptions,
  probeValues, createdAt, updatedAt.
- `ConnectorServerHeldInstanceInput`: label and fields.
- `ConnectorServerHeldProbeResult`: the same non-secret inspection fields as
  an instance, without persistence ids/timestamps.

## OpenLark extension

The folder contains `foundry-extension.json` and a bilingual `README.md`.
The manifest points `olk` at `{gatewayBase}` through a `{standIn}`, sets
`OPEN_LARK_MCP_READ_ONLY=1`, and uses the account selected from
`GET /agent/v1/accounts`. The route directory comes from `GET /agent/v1/`.
The optional capabilities probe reads the service version.

The README tells the NAS owner to enable
`LARK_AGENT_LEGACY=token`, generate
`OPEN_LARK_AGENT_READ_TOKEN=<openssl rand -hex 32>` and restart before adding
the instance. It explains that the URL is the public HTTPS root, the account
is chosen after a successful probe, and the token is sealed by Foundry.

## Deletion and migration list

- Remove OpenLark from `catalog.json` and the default provider registry.
- Remove `externalaccounts/openlark*.go`.
- Remove `connectors/openlark_gateway*.go`.
- Remove `httpapi/openlark_connectors.go` and its routes.
- Remove `store/openlark.go`, `sqlitestore/openlark.go` and the
  `OpenLarkStore` interface additions.
- Remove `worker/connectors/openlark.ts` and its test.
- Remove OpenLark contract types and generated outputs.
- Drop `openlark_instances` only after confirming it is empty.
- Rewrite the DEV-159 devlog and the OpenLark section of
  `docs/connectors.md` to describe the generic extension mechanism.
- Delete the old Web OpenLark form in slice B.

## Verification

- Descriptor: accepts a valid synthetic `acme-api` descriptor; rejects
  unknown template references, secrets in session env, unsafe paths, invalid
  route extraction, a missing access probe and excessive limits.
- Probe: extracts options/values/routes, classifies 401/403/404/TLS/timeout/
  non-JSON and refuses private addresses and redirects.
- Gateway: injects templated headers, strips device/stand-in credentials,
  enforces probe-derived read/write levels, refuses unknown and over-level
  routes, and audits without secrets.
- Session: environment contains only stand-ins and non-secret values; the
  real token is absent; `probeMap` reflects the validated scope; off/read
  permission packages deny calls and assistant writes require confirmation.
- Removal: the remaining connector tests pass and OpenLark no longer appears
  in the built-in catalog or generic provider list.

No real NAS is called by tests.
