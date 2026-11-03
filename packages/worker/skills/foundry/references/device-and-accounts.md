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
  profile's app secret and token are stand-ins that stop working when the
  session ends. Not available through it: `feishu-cli auth token --as bot`,
  the token check of `feishu-cli doctor`, and `feishu-cli markdown fetch
--as bot` (fetch as the user). A refused call says why ("Foundry gateway:
  …"). If a command fails unexpectedly, tell the person which feishu-cli
  version this device has.
- **Cloudflare** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_BASE_URL`): the
  official `cf` CLI (0.14.0 verified) and the `cloudflare` MCP tool read
  only the zones, DNS records and certificate metadata the binding selects.
  When the workspace has several Cloudflare identities the CLI has none
  selected; the MCP tool names its account explicitly. Manage zones and
  authorization in Connectors → Cloudflare.
- **Device CLIs with the device's own sign-in** (AWS CLI, and tools
  connector extensions on the device provide): a workspace either may use
  the device's sign-in as it is, or is kept from it by variables Foundry
  set (such as an empty profile variable, cleared AWS credential
  variables); keep those variables. Check the identity with the tool itself
  before acting (`aws sts get-caller-identity`, or the tool's own status
  command), which does not prove a service's permissions. A tool may need a
  separate sub-authorization (a web session) for part of its service: check
  its status with a read-only command before asking (unverified is not
  missing), and when a service reports missing authorization, name that
  exact sub-authorization to the person. Never repeat a business write to test authorization.
