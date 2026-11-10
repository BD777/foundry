# The device and the accounts Foundry connected

What a device offers changes while you work; read it when it matters with
`list_resources`, never from memory or an earlier answer.

## Browsers

- `list_resources` lists the device's browsers. When `$FOUNDRY_BROWSER_BIN`
  is set, it holds a launcher for each, named after the browser
  (`google-chrome`, `playwright-chromium`): a browser started
  through one is recorded for your session and closed when your reply ends.
  playwright-cli and Playwright MCP already use the launcher of the
  device's isolated Chromium.
- Pick per task. A Playwright or Chrome for Testing build is isolated and
  never updates itself, so prefer it for headless work. An everyday browser
  (Google Chrome, Edge) may try to update itself when it starts, which macOS
  can block with an App Management notice.
- Give each run its own `--user-data-dir` under `$TMPDIR`. A fresh one has
  none of the person's sign-ins: when a task needs them, find the browser
  profiles on the device, ask the person which one to use, and use only that
  one.

## Screen control (computer use)

- A macOS screen control instance (type computer_use) with a ready
  `cua-driver` backend is leased with `acquire_resource` and driven with
  `operate_resource` (screenshots, clicks, typing), from this device or
  another.
- An instance that is not ready says why. The device's owner fixes it on the
  Resources page in Foundry (for example Request access, which starts
  CuaDriver and asks macOS for its permissions); tell the person what is
  missing instead of working around it, for instance by restarting their
  apps with debugging ports.

## Accounts reached through Foundry

These are set up per session; their variables show which ones you have.
Never run a tool's own login, logout, token export or profile switch:
credentials stay with Foundry or on the device, and a missing permission is
re-authorized by the person in Foundry's Connectors.

- **Feishu** (`FEISHU_PROFILE`): `feishu-cli` uses the selected profile;
  other connected accounts are further `foundry-…` profiles for `--profile`.
  Calls go through Foundry's gateway, as the person or as the app's bot; the
  profile's app secret and token are stand-ins. They work during your turns
  and for what you leave running after one (a background command, a timer,
  the turn you start on its notification), so long jobs may run in the
  background; they stop when the session is stopped or archived, about two
  minutes after nothing of yours runs any more, and a day after your last
  turn at the latest. Not available through it: `feishu-cli auth token --as bot`,
  the token check of `feishu-cli doctor`, and `feishu-cli markdown fetch
--as bot` (fetch as the user). A refused call says why ("Foundry gateway:
  …"). If a command fails unexpectedly, tell the person which feishu-cli
  version this device has.
- **Cloudflare** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_BASE_URL`, usually `CLOUDFLARE_ACCOUNT_ID`): use
  the official `cf` CLI (0.14.0 verified) or curl on that base URL as they
  are; there is no Foundry tool for it. The token is a stand-in and the base
  URL a loopback forwarder: the Foundry server decides every request, of any
  method, and acts as the one Cloudflare identity the workspace binds.
  Reads cover the bound zones' DNS, SSL and certificate metadata.
  `cf zones list` shows only the bound zones (`--name` filters among them).
  `CLOUDFLARE_ACCOUNT_ID` is set when every bound zone is in one Cloudflare
  account, and then `--zone` takes a domain or an ID; when it is not set
  (zones in several accounts), cf's lookup of a zone by domain fails, so
  get the ID with `cf zones list --name <domain>` and pass that.
  Changes (POST, PATCH, PUT, DELETE of DNS records) work only where the
  person set the workspace's access to DNS edit, and that can change during
  a session: after a refusal, retry rather than restart. A refusal is an
  HTTP 403 in Cloudflare's error shape with a `foundry` object (`reason`,
  `needed`, `current`, `where`): tell the person what it says; do not look
  for another credential. Cloudflare's own errors arrive unchanged. If a
  change on this device fails at once with "This connector is read-only."
  from 127.0.0.1, the device's Worker predates `cloudflare_gateway_v2`: ask
  the person to update it. Manage zones and authorization in Connectors →
  Cloudflare.
- **App Store Connect** (`ASC_API_BASE_URL`, `ASC_API_TOKEN`): use `curl`
  against the official API paths and send the stand-in as a bearer token.
  The base URL is a loopback forwarder; the server replaces the stand-in
  with a cached Apple JWT. The .p8 and real JWT are never in the session.
  Only apps bound to this workspace, within its `read` or `commerce` level,
  are forwarded. Use the key's visible app ID rather than listing the whole
  team (account-wide `/apps` is refused).

  List subscription groups:

  ```sh
  curl -sS -H "Authorization: Bearer $ASC_API_TOKEN" \
    "$ASC_API_BASE_URL/apps/<app-id>/subscriptionGroups?limit=10"
  ```

  Create a subscription under a bound subscription group:

  ```sh
  curl -sS -X POST \
    -H "Authorization: Bearer $ASC_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"type":"subscriptions","attributes":{"name":"Yearly","productId":"com.example.yearly"},"relationships":{"subscriptionGroup":{"data":{"type":"subscriptionGroups","id":"<group-id>"}}}}}' \
    "$ASC_API_BASE_URL/subscriptions"
  ```

  Upload a review screenshot with Apple's reserve → pre-signed upload →
  commit sequence. Reserve it under the subscription, upload the bytes to
  each returned `uploadOperations[].url` with that operation's method and
  request headers, then mark the screenshot uploaded:

  ```sh
  curl -sS -X POST \
    -H "Authorization: Bearer $ASC_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"type":"subscriptionAppStoreReviewScreenshots","attributes":{"fileName":"review.png","fileSize":12345},"relationships":{"subscription":{"data":{"type":"subscriptions","id":"<subscription-id>"}}}}}' \
    "$ASC_API_BASE_URL/subscriptionAppStoreReviewScreenshots"
  curl -X PUT --upload-file review.png "<pre-signed upload URL>"
  curl -sS -X PATCH \
    -H "Authorization: Bearer $ASC_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data":{"type":"subscriptionAppStoreReviewScreenshots","id":"<screenshot-id>","attributes":{"uploaded":true}}}' \
    "$ASC_API_BASE_URL/subscriptionAppStoreReviewScreenshots/<screenshot-id>"
  ```

  A refusal is an HTTP 403 with an Apple-shaped error and a `foundry`
  object naming the reason. Price changes, review submission and requests
  that cannot be mapped to a bound app are refused; direct the person to
  App Store Connect for those. If a new workspace binding or level is
  needed, ask the person to change it in Connectors → the workspace → App
  Store Connect.

- **Device CLIs with the device's own sign-in** (AWS CLI, GitHub CLI,
  Tencent Cloud `tccli`, Alibaba Cloud `aliyun`, and tools connector
  extensions on the device provide): a workspace either may use
  the device's sign-in as it is, or is kept from it by variables Foundry
  set (such as an empty profile variable, cleared AWS credential
  variables); keep those variables. Check the identity with the tool itself
  before acting (`aws sts get-caller-identity`, `gh auth status`,
  `tccli sts GetCallerIdentity`, `aliyun sts GetCallerIdentity`, or the
  tool's own status command), which does not prove a service's permissions
  (cloud permissions come from the account's CAM / RAM policies). A tool may need a
  separate sub-authorization (a web session) for part of its service: check
  its status with a read-only command before asking (unverified is not
  missing), and when a service reports missing authorization, name that
  exact sub-authorization to the person. Never repeat a business write to test authorization.
  For a connector a session may use, Foundry links its tool into the
  session's own bin folder, first on PATH, and for GitHub CLI also gives git
  the gh login as a credential helper for github.com in this session only
  (`git clone https://github.com/<private repo>` works without asking for a
  username; nothing is written to the person's git configuration). The
  Connectors page shows "Sessions can use it" apart from "signed in"; if
  `gh` or the git credential is missing here anyway, say what is missing
  and ask the person to check the connector there, never for a token.

- **GitHub scopes** (`workflow`, `read:packages`, `admin:org`…): the
  person chooses them in Connectors → GitHub CLI → the device → GitHub
  permissions (recommended, all of GitHub's scopes, or custom; adding and
  removing). In a session `gh auth login`, `logout`, `refresh`, `switch` and
  `setup-git` are refused. When GitHub reports a missing scope, show its
  error as it is (it names the scope, e.g. `missing required scopes
[workflow]`): Foundry turns that into a "Needs you" item whose button
  opens the device's picker with the scope selected. Ask the person to
  approve it there, then continue in a new turn.
- **GitHub Packages and GHCR**: Connectors → GitHub CLI shows package
  reading as its own capability and lets the person enable GHCR for Docker. The latter is a credential bridge, not another
  GitHub scope: authorized sessions get a private Docker configuration and
  a native credential helper that reads the current gh login only for ghcr.io.
  Use Docker normally; never export the token or run docker login yourself.
  After enabling it, continue in a new turn so the session receives the new
  environment. If DOCKER_CONFIG or docker-credential-foundry-ghcr is absent,
  check the device Worker and execution-host version; don't ask for a token.
