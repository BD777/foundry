# Foundry Security Boundary

## Scope

Foundry is local-first. The paired worker, not the control-plane server, is the trusted owner of local workspaces and provider execution.

```text
browser
  -> authenticated Go control plane
    -> paired outbound worker connection
      -> local workspace, credentials, commands, and runtimes
```

The controls below make accidental network exposure fail closed. Every browser API call requires a Foundry account, and access to devices, workspaces and connections follows ownership and workspace roles (see [Accounts](#accounts) and the [accounts and permissions design](accounts-permissions-design.md)). None of this replaces TLS termination or host hardening.

## Safe Defaults

- The Go server binds to `127.0.0.1:31982` by default.
- The Vite development server binds to `127.0.0.1:31983`.
- The accepted browser origin defaults to `http://127.0.0.1:31983`.
- There is no anonymous mode, on loopback or otherwise: a reverse proxy makes every request look like loopback, so loopback is never trusted as an identity.
- The retired `FOUNDRY_AUTH_MODE`, `FOUNDRY_CONTROL_TOKEN` and `FOUNDRY_PAIRING_CODE` settings make startup fail instead of being silently ignored.
- The development reset endpoint is disabled unless `FOUNDRY_ENABLE_DEV_RESET=1`.

## Authentication Channels

Browser control-plane requests authenticate with the account session cookie described below.

Daemon registration and WebSocket requests use the device's own credential:

```text
X-Foundry-Device-Credential: <device credential>
```

- A signed-in account issues a one-time pairing token (256-bit, SHA-256 stored, 15 minutes from the web app, one hour from `foundry-server devices pairing-token`). `POST /api/daemon/pair` redeems it once for a device credential; the server stores only the credential's hash and binds it to the issuing account and to hashes the worker reports: of its own state (machine id, numeric uid or Windows SID, state root), of its system account (machine id, uid, the account's own `~/.foundry`) and of the machine. Raw ids and user names never leave the machine. `/api/daemon/pair` is the only daemon route reachable without a credential; failed redemptions are rate-limited per client IP.
- One worker state root of one system account is one device per Foundry account: pairing it again keeps the device and rotates its credential (the old one stops working and its live connection is closed). Devices paired before workers reported their own fingerprint keep their ids. Removing a device revokes its credential; its id is never reissued.
- One system account belongs to one owner by default. Pairing a worker whose system account another person's live device already uses pairs nothing (409 `system_account_shared`, token kept) until that person chooses to share it, in the terminal or the web; the choice is recorded (who, when), both devices are labelled for their owners, the earlier owner is notified once, and sessions on those devices are told the account is shared. This is sharing, not isolation: within one system account files, Claude/Codex logins and the device credential (see the known risk below) are reachable by everyone using it. Separate people get separate system accounts ([devices and workspaces](devices-and-workspaces.md)).
- Every registration (HTTP or WebSocket) and issue claim must name the credential's own device. A workspace id already registered by another live device cannot be taken over.
- The worker saves the credential in `~/.foundry/daemon-config.json` (owner-only). The same header on a browser route acts as the device owner's account, which is how the daemon and the local `foundry` CLI reach browser routes. Disabling the owner disables the device.
- Agent sessions use their own session-scoped Bearer tokens.

### Accounts

- Every browser `/api/` call needs the `foundry_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` when `FOUNDRY_WEB_ORIGIN` is `https`). Only `GET /api/auth/state`, login, logout, first-admin setup and invite preview/accept are reachable without it; `/healthz` and the static web app are public. Cookies also cover SSE, local images and downloads, so no token appears in URLs. A test parses every registered route and fails if any other `/api/` route answers without credentials.
- Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must carry an `Origin` equal to `FOUNDRY_WEB_ORIGIN`; a missing or foreign `Origin` is rejected (CSRF defense on top of `SameSite`).
- Passwords are bcrypt hashes (cost 12, 10–72 bytes). Session and invite tokens are 256-bit random values; only their SHA-256 is stored. Sessions last 30 days and slide at most once a day. Changing a password or disabling a user revokes every session of that user.
- While no account exists, the server logs a one-time setup code at startup; creating the first admin requires it, so an exposed empty server cannot be claimed by a stranger. `foundry-server users create|reset-password|list` manages accounts from the host shell.
- Failed logins lock the client IP and the username+IP pair for 15 minutes after 5 failures in 15 minutes. `X-Real-IP` is trusted only from a loopback peer (the local reverse proxy). Unknown usernames spend the same bcrypt time as wrong passwords.
- Authorization follows ownership ([accounts and permissions design](accounts-permissions-design.md)). Every API route declares one access rule in `apps/server/internal/httpapi/routes.go`; a test fails on a route without one and proves every non-public route answers 401 anonymously.
  - Workspaces: access comes only from `workspace_members` (Viewer < Member < Maintainer < Owner). Viewers read; members chat, create and clarify Issues, run and verify, and control their own sessions; maintainers also Accept/Abandon, control anyone's sessions and manage skills and the Feishu bot; owners also rename and delete. A device's owner is always an Owner of the workspaces registered on it.
  - Devices: device management (settings, native logins, connection assignment, skill roots, removal, new workspaces, directory browsing) is limited to the device owner. Others only see a device that hosts a workspace they can view, without its execution settings.
  - Connections (server profiles): only their owner can list, edit, delete or authorize them. Listing a profile's models needs the connection or a visible device; the stored key never leaves the server.
  - Responses carry the caller's own `accessRole` on each workspace and `owned` on each device so the web can disable what the caller cannot do; the server still decides every request, and a role denial answers 403 naming the caller's role and the role required.
  - Sharing: workspace Owners add people by exact username (no account listing), change roles or remove them; anyone may leave; the device owner always stays an Owner. A role change takes effect at once: the account's event streams are closed so they reconnect with the new reach, and losing run access (removal, below Member, or a disabled account) cancels that account's running sessions and revokes their agent tokens. Agent tokens act with their creator's current role, capped at Member. Invites may carry a workspace role, only for a workspace the inviting Admin owns.
  - The instance Admin role manages accounts, invites, the global skill catalog and dev reset. It grants no access to other people's workspaces.
  - Reads are filtered per caller: lists, `GET /api/foundry-data` (cached per caller reach), images under attachment roots, and the event stream (each subscriber only receives events of workspaces it can view; events without a workspace are dropped). Resources the caller cannot see answer 404, so their existence does not leak.
  - A Feishu group acts as the account that generated the pairing code it used. Each message is re-checked against that account's current status and role (Member or above) in the workspace; otherwise the bot replies with the reason and runs nothing. Pairing codes are single-use, expire after 10 minutes and are stored only as SHA-256; the plaintext appears only in the response that generated it.
  - A device credential acts as its owner, limited to the workspaces on that device, and never with admin rights. Every daemon message about an issue, run or session must target that device's own work. An agent acts as the account that started its session, limited to its workspace and never above Member.
- Human decisions (contracts, clarifications, verification, evidence, Accept) are attributed to the logged-in account as `ActorRef{kind:"user"}`.

Authentication comparisons use constant-time equality. CORS and browser-origin WebSocket checks accept only the exact normalized `FOUNDRY_WEB_ORIGIN`.

## Remote Exposure

Do not expose the server directly over plain HTTP. Put it behind TLS, serve the web app and `/api/` from the same origin, and set the exact browser origin:

```bash
FOUNDRY_WEB_ORIGIN=https://foundry.example pnpm dev:server
```

For Vite behind the proxy, run with `VITE_API_BASE_URL=` empty and `FOUNDRY_WEB_PUBLIC_HOST=<host>`; a production build uses the same empty `VITE_API_BASE_URL`.

Operational requirements for remote use:

- terminate TLS before the Go server;
- restrict network reachability to intended users and devices;
- set `FOUNDRY_WEB_ORIGIN` to one exact browser origin;
- remove and re-pair a device whose credential may have leaked;
- keep `FOUNDRY_ENABLE_DEV_RESET` unset.

## Data Placement

The control plane may store or relay:

- workspace and device projections;
- provider label, runtime, model, base URL, status, and auth-mode metadata;
- normalized issue, run, chat, and session events;
- explicitly requested read-only workspace file content;
- explicitly requested content of a session's recorded files (see Local Files);
- attachment metadata and review artifacts.

Custom endpoint profiles may hold an `apiKey` only through the sealed secret
store: the profile editor sends it write-only, it is sealed before storage, no
API returns it, and it is decrypted solely for transient dispatch to the paired
daemon. The daemon never persists that dispatched key. The control plane does
not accept profile `env` or `command`; those stay in machine-local worker
configuration. Without a secret-store key, custom credentials are rejected
rather than degraded to plaintext storage.

Official account profiles use the native agent CLI login instead of moving an
OAuth credential through Foundry. The person signs in on the device itself
(`claude`, then `/login`; or `codex login`); Foundry starts no login and relays
no authorization code. The CLI owns its keychain or local credential file. A
server profile stores only the official/custom mode and runtime defaults, so
each device must authorize its own official login. Foundry never reads or
stores the resulting OAuth tokens.

Model catalogs are the one provider HTTP call Foundry makes: a profile's configured endpoint is asked for `/models` with the key
that profile would run with, because no native CLI can enumerate a compatible
endpoint's catalog. It is a metadata read — never a completion — and the daemon
performs it so the key stays on the machine that already holds it. Neither the
key nor the response is logged. Inference still goes only through the native
agent SDK or CLI, and a local login is never asked over HTTP: Claude's catalog
comes from the Agent SDK's `supportedModels()`, Codex's from its native
`model/list` with the CLI's bundled `debug models` catalog as fallback.

### Server profiles versus device profiles

A server profile is a global control-plane record (`profiles`) that a device
opts into through an explicit binding (`device_profiles`). Custom profiles
seal their credential under `agent-profile:<profileID>` and dispatch it only
for a run. Official profiles carry no server credential and use the selected
device's native CLI login. The full profile definition still accompanies every
session so runtime, endpoint, model, and execution defaults cannot silently
fall back to another local profile.

A device profile is whatever the daemon discovered on that machine. It stays
machine-local. Local-login, environment and custom-command profiles cannot be
promoted to server profiles. A native local-login profile may be represented by an official server
profile, but its authorization remains device-local and must be repeated on
each enabled device.

`POST /api/profiles/promote` copies an API provider from a device's own
Claude Code / Codex configuration into a server profile (label, runtime, base
URL, models) or, for a provider promoted before, updates that profile; the
source is recorded as device id + the provider's id there
(`profile_promotions`). The device's configuration is never modified. Only the
device owner (or an admin, for an unowned device) may call it. A key is copied
only when the request carries `copyKey`, which the web sends only after the
person ticks it in the confirmation dialog:

- the credential is already sealed server-side under the legacy device-scoped
  id `agent-profile:<deviceID>:<profileID>`. The server unseals with its own
  KEK and reseals under `agent-profile:<profileID>`.
- otherwise the server asks the device over the daemon socket
  (`read_provider_key` / `provider_key_read`) for the key that provider's own
  configuration names (Codex `env_key`, a bearer token or Authorization header
  in config.toml, `env.ANTHROPIC_AUTH_TOKEN`/`_API_KEY` in Claude's settings,
  or the key in Foundry's profiles file). The request names the provider,
  never a variable, and nothing else in the daemon's environment stands in
  for it. The value is sealed on arrival and never logged, echoed or returned
  to the browser; the device list reports only the key's name (`keySource`).
  A provider that names no key, or whose key is empty, fails a confirmed copy
  before anything is written. Without `copyKey` no key is read, and a key the
  profile already holds stays.

A provider whose base URL is a loopback address (localhost, 127.0.0.0/8,
::1) stays bound to the device it was promoted from: the server refuses to
enable it on any other device.

## Secret Store

The envelope-encrypted secret store backs the credential rules above.

- Records live in SQLite (`secret_records`); each is sealed with its own
  random AES-256-GCM data key, and that key is wrapped by a key-encryption
  key (KEK). Rotating the KEK re-wraps 32 bytes per record and never touches
  ciphertext.
- The KEK file is `<database directory>/foundry-secret.key` (override with
  `FOUNDRY_SECRET_KEY_PATH`), a single `FOUNDRY-SECRET-KEY-1` payload line
  plus fingerprint comments. It is generated automatically on first start,
  written atomically with mode `0600`, and lives with the database in the
  private state root (`~/.foundry/server/` by default, directory `0700`),
  outside any checkout, so tools that serve or mount the repository never
  reach it. It must never be committed or copied into a backup of the database
  alone — migrating a deployment means copying database and key file together.
- The database stores a canary sealed under the KEK. Startup verifies it and
  fails closed on mismatch, naming the expected fingerprint. A lost key file
  is recoverable only through `foundry-server keys reinitialize
--accept-data-loss`, which discards stored secrets.
- `foundry-server keys generate | fingerprint | rotate | reinitialize`
  manage the lifecycle. Rotation stages the new key as `foundry-secret.key.new`,
  re-wraps the database in one transaction, then promotes; a crash before
  promotion self-heals on the next start by verifying the staged candidate
  against the new canary.
- Sealing and unsealing use the in-memory KEK only; no request path re-reads
  the key file.

## Local Files

Private worker JSON is written atomically with owner-only permissions:

- directories: `0700`;
- files: `0600`.

Uploaded attachments are stored under a registered workspace's `.foundry/attachments/` directory with the same private permissions. Image reads:

- resolve symlinks before authorization;
- reject paths outside every registered attachment root;
- allow only regular GIF, JPEG, PNG, or WebP files;
- cap served images at 25 MiB;
- disable browser caching.

Multipart attachment uploads are capped at 100 MiB per request. Files a
Workspace Bot receives in Feishu messages (images, files, voice, video, images
and videos inside rich text) are downloaded by the server with the bot app's own token and
stored the same way, within the same 100 MiB per message
(`apps/server/internal/feishu/message_files.go`); types it cannot carry, such
as stickers, reach the session as a short marker like `[sticker]`.

A session's files are read only through its ledger,
`<workspace>/.foundry/sessions/<id>/files.json` (owner-only, like other
session artifacts). It lists the files the session's own write tools changed
(main agent and subagents, inside or outside the workspace) and the paths its
answers name that the device verified; nothing is credited from files merely
changing on disk. A named path outside the workspace must be a regular file in
a temporary folder (`os.tmpdir()`, `/tmp`, `$TMPDIR`) or the workspace,
modified after the turn started. Reads:

- serve only ledger paths whose resolved path still matches the one recorded;
- refuse `~/.ssh`, `~/.foundry`, `~/.claude*`, `~/.codex`, the workspace's
  `.foundry`, `.git`, `*.pem`, `id_*` and `.env*`, whatever the ledger says;
- read at most 256 KiB of text (2 MiB for an inline image) without loading
  the rest; binaries return only their size;
- answer `Cache-Control: no-store`. Viewers may read tool-written files and
  files inside the workspace; a named file outside it needs Member.

Workspace file reads (`/api/workspace-files/read`) likewise read only their
first 128 KiB.

## Agent Credentials

- A session's Foundry token reaches its agent, never the commands the agent
  runs: Claude Code is handed its Foundry tools over its input stream, Codex
  reads the token from its own environment, excludes it from its shell and
  runs without a shell snapshot. A `foundry` command inside a session never
  falls back to the device credential. A token is valid while its session is
  queued, running or blocked, otherwise for 24 hours after its last use, and
  never longer than 30 days; a timer Claude fires itself gets a fresh one
  (`POST /api/daemon/sessions/{id}/session-tokens`, the session's own device
  only). Details: [session orchestration §4.2](session-orchestration-design.md).
- Sandboxed agents (an Issue's execution, clarification, verifiers) get the
  device's Claude and Codex access tokens, never a refresh token, so nothing
  in a sandbox can rotate the device's login. The device renews its own Claude
  login with its own CLI as the token nears expiry, and the copy follows one
  way, device to sandbox (`packages/worker/src/session/provider-credentials.ts`).
- The worker removes the tokens it knows (session tokens, the device
  credential) and common secret shapes from transcripts before they leave the
  device (`packages/worker/src/secret-redaction.ts`).

### Known risk: the device credential is readable by unsandboxed agents

Chats and orchestrated sessions outside an Issue run as the device's user
without an OS sandbox. Such an agent, prompt-injected or not, can read
`~/.foundry/daemon-config.json`, which holds the device credential (it acts as
the device's owner on every workspace of the device), and the environments
and memory of the user's other processes (`/proc/<pid>/environ`, and
`/proc/<pid>/mem` where `ptrace_scope` is 0), including the agent processes
that hold session tokens and provider logins. Keeping tokens out of command
environments stops casual leaks, not a determined agent. Options, not yet
chosen:

- **OS-level isolation for every session**, as Issue sandboxes already have:
  the agent's process tree cannot read the worker's state directory or other
  processes. Costs: some tools that expect the whole home stop working.
- **Move the credential out of the agent's reach**: keep it in the OS
  keychain or a root/other-user-owned helper the worker talks to, so the
  agent's user cannot read it directly. Does not protect other processes'
  environments without isolation.

## External Accounts (Connectors)

A person's server-held logins at third-party platforms (today Feishu, used
through feishu-cli) live on the server, never on a device
(`apps/server/internal/externalaccounts`, routes in
`httpapi/external_accounts.go`).

- Apps: a pasted Feishu app, or one Foundry registers for the person, is
  theirs; only an Admin creates an instance-wide app. Its secret is sealed under
  `external-app:<appID>` right after the row exists and is never returned by
  any API; only the app's owner (or an Admin, for an instance app) replaces
  it. Apps whose secret older workers received are flagged for rotation.
- Logins: the server runs the OAuth device flow itself; the person approves
  in Feishu. A login always asks for `offline_access`, and a grant without a
  refresh token is refused. The grant is sealed under
  `external-account:<accountID>`; the server is its only refresher (Feishu
  refresh tokens are single-use), and keep-alive (on by default) renews it
  before it lapses.
- Ownership: only an account's owner sees, refreshes, revokes or disconnects
  it. Workspace bindings are read by Viewers and set by Maintainers, and a
  person binds only their own accounts; bindings and their changes are
  audited (`external_account_events`).
- Lending to sessions: a session may act as an account only while
  `externalaccounts.Eligible` holds: the session was started by the account's
  owner, on a device that owner owns, in a workspace the account is bound to,
  and the account is ready or expiring. Issue executions and clarifications
  (sandboxed HOME) get no account, nor does a worker without the gateway
  forwarder. The session receives only gateway stand-ins (below), written into
  a feishu-cli profile of its own that the worker removes when the run ends
  (`packages/worker/src/connectors/feishu.ts`).
- Revoke ("stop using now") revokes the grant at Feishu and deletes it here;
  disconnect also removes the account and its bindings. Either way the
  gateway refuses the account's stand-ins from the next call on.

## Device-held Connectors

A device-held connector's login (today bytedcli's ByteCloud Auth sign-in)
is kept by its CLI on the device and never leaves it
(`apps/server/internal/connectors`, routes in `httpapi/connectors.go`,
worker `packages/worker/src/connectors/device-held.ts`).

- The server stores only what the device read: installed or not, version,
  signed in or not, the user name the CLI shows (never an email; the server
  also cuts anything after an `@`), the sites and when the login ends. It
  never receives a token, the sign-in's complete token or a QR image; a
  sign-in relays only the verification page's https address.
- Only the device's owner reads, installs, signs in or signs out a
  connector on that device; an Admin acting on an ownerless device is
  refused. Install goes through the managed-tools path (npm, no install
  scripts, the device's own npm settings); sign-out runs only on the
  owner's confirmed request.
- Session access: the device owner's own unsandboxed sessions on that
  device automatically receive a login reported as signed in and ready or
  expiring, with expiry recalculated at dispatch. Other members still need
  a matching workspace/device/owner binding with `members=true`, checked by
  `connectors.DeviceEligible`, and a usable login. Issue executions,
  clarifications and verification sessions get nothing. A session someone
  else started on the device, when not allowed or the login is unavailable,
  gets the connector's isolation (`BYTEDCLI_PROFILE` on an empty profile),
  which prevents accidental use only: an unsandboxed session runs as the
  device's user (see the device-credential risk above).
- Foundry's own runs of the CLI set `BYTEDCLI_NO_AUTO_UPGRADE=1` and drop
  an inherited `BYTEDCLI_PROFILE`, so reading the status neither upgrades
  the person's CLI nor reads another profile.

## Feishu Gateway

Sessions reach Feishu only through `/api/feishu-gw`
(`apps/server/internal/feishugateway`, wired in
`httpapi/external_accounts_gateway.go`), so no app secret or Feishu token is
ever sent to a device.

- Stand-ins: per session and account the server issues an app-secret handle
  `fsg_` (32 random bytes) and derives the user-token (`fsu_`), refresh
  (`fsr_`) and tenant-token (`fst_`) handles from it by HMAC. Only their
  SHA-256 hashes are stored. feishu-cli holds them in place of the real
  values, with its base URL on the worker's loopback forwarder
  (`packages/worker/src/connectors/feishu-gateway-forwarder.ts`, `127.0.0.1` only),
  which adds the device credential and pipes each request to the gateway.
- Every request is authorized afresh: the route accepts only a device
  credential; the handle must name a live grant for that same device; the
  session must still be queued, running or blocked on it, started by the
  account's owner; and the account must still be `Eligible`. An ended session,
  a revoked or disconnected account, or a removed binding is refused on the
  next request, whatever expiry feishu-cli was told (30 days).
- The gateway answers feishu-cli's tenant-token call and its user-token
  refresh itself, with the same stand-ins; it never returns a real token.
  Forwarded calls get the real token swapped in (the user's from the
  externalaccounts service, the app's tenant token fetched with the sealed
  secret and cached), with the device credential, cookies and forwarder
  header stripped.
- Scope: calls pass within what Feishu grants the account's login or the app;
  the gateway does not widen or narrow scopes. It refuses only
  (`feishugateway/policy.go`): `auth/` and `authen/` (except
  `authen/v1/user_info`), writes under `application/`, `admin/`, `passport/`
  and `security_and_compliance/`, and every path outside `/open-apis/` but
  its event endpoints, so sessions cannot log in, mint tokens, register apps
  or reconfigure the tenant.
- Limits and audit: per session 20 calls/s (burst 60), per app 50 calls/s
  (burst 150), before Feishu's own limits. One audit line per request (method, path
  with ids replaced by `:id`, identity, outcome, bytes, duration; never
  bodies), kept 30 days; people read their own sessions' lines, an Admin
  everyone's. Grants of ended sessions are pruned hourly.
- Events: `feishu-cli event consume` connects to an emulated long-connection
  endpoint fed by the server's single connection per app
  (`apps/server/internal/feishuevents/socket.go`), with a single-use ticket
  valid for a minute; the socket is re-checked and closes when access ends.
- With integrations off (`FOUNDRY_INTEGRATIONS=off`) nothing is forwarded to
  Feishu.

## Protocol Validation

- Normal JSON API bodies are capped at 1 MiB and reject unknown fields, trailing values, and malformed JSON.
- WebSocket envelopes reject unknown fields and require a `hello` message before other daemon messages.
- The shared protocol validator caps messages at 2 MiB and message IDs at 256 characters; the worker WebSocket client enforces the same 2 MiB maximum payload.
- The server's daemon socket reads frames up to 96 MiB so that skill packages (up to 64 MiB compressed) fit.

## Security Regression Checks

Run:

```bash
pnpm verify
```

The gate includes TypeScript builds and tests, Go tests and vet, strict protocol tests, server authentication/origin/filesystem tests, and web UI audits. GitHub Actions also runs `pnpm format` and `pnpm verify` for every push and pull request.

When changing the boundary, add a regression test for both the accepted path and the rejected path.
