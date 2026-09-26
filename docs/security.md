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

Daemon registration, polling, and WebSocket requests use the device's own credential:

```text
X-Foundry-Device-Credential: <device credential>
```

- A signed-in account issues a one-time pairing token (256-bit, SHA-256 stored, 15 minutes from the web app, one hour from `foundry-server devices pairing-token`). `POST /api/daemon/pair` redeems it once for a device credential; the server stores only the credential's hash and binds it to the issuing account and to a hash of the OS machine id. `/api/daemon/pair` is the only daemon route reachable without a credential; failed redemptions are rate-limited per client IP.
- One machine is one device per account: pairing it again keeps the device and rotates its credential (the old one stops working and its live connection is closed). Removing a device revokes its credential; its id is never reissued.
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
- attachment metadata and review artifacts.

Custom endpoint profiles may hold an `apiKey` only through the sealed secret
store: the profile editor sends it write-only, it is sealed before storage, no
API returns it, and it is decrypted solely for transient dispatch to the paired
daemon. The daemon never persists that dispatched key. The control plane does
not accept profile `env` or `command`; those stay in machine-local worker
configuration. Without a secret-store key, custom credentials are rejected
rather than degraded to plaintext storage.

Official account profiles use the native agent CLI login instead of moving an
OAuth credential through Foundry. Claude authorization runs `claude auth login`;
Codex authorization runs `codex login --device-auth`. The CLI owns its keychain
or local credential file. A server profile stores only the official/custom mode
and runtime defaults, so each device must authorize its own official login.
Foundry relays only the authorization URL, one-time device code, completion
status, and an optional callback code supplied by the user; it never reads or
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

`POST /api/profiles/promote` converts a device profile into a server profile.
Only the device owner may call it, and the server needs a secret-store key.
Two credential paths exist:

- the credential is already sealed server-side under the legacy device-scoped
  id `agent-profile:<deviceID>:<profileID>`. The server unseals with its own
  KEK and reseals under `agent-profile:<profileID>`. No plaintext leaves the
  machine that did not already leave it, so this path needs no consent.
- the credential exists only in the daemon's local file. Promotion is then the
  explicit act that moves it to the server: the server requests it over the
  daemon socket (`read_profile_credential` / `profile_credential_read`), seals
  it on arrival, and never logs or echoes it. A device that holds no key for
  the profile fails the promotion instead of creating a profile that cannot
  authenticate.

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

Multipart attachment uploads are capped at 100 MiB per request.

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
