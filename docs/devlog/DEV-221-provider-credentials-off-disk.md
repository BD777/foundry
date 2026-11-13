# DEV-221 Provider credentials out of Claude settings files

## Problem

sess_1794559698135735487 (DEV-213, sg-chaos) ran `cat ~/.foundry/claude-settings/<owner>/*.json` to look at Foundry's Claude execution config. The output included **another session's Tencent TokenHub (Claude) key**. Foundry writes a `--settings` file for each Claude turn, and its `env` was the whole runtime environment from `profileRuntimeEnvironment`, `ANTHROPIC_AUTH_TOKEN` included. The file was 0600 in a 0700 directory, but every Foundry session runs as the same OS user, so every session's agent could read every other session's file.

## Investigation

- **The key in the file did nothing.** The SDK already passes the same values to the process as `env` (`sessionEnvironment` → `profileRuntimeEnvironment`). Foundry sets `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, and with that set Claude Code ignores provider-selection, endpoint and authentication variables in settings files (official docs: code.claude.com/docs/en/env-vars, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; the CLI 2.1.318 bundled with SDK 0.3.318 has the same list). The file still has to pin models and the context window, which user settings could otherwise change. It does not need the key.
- Inventory of what the Worker writes to disk (Claude and Codex):

| Where                                                                                                                                                                                                                       | What                                                                                                | Before                                                    | Now                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.foundry/claude-settings/<owner>/<sha>.json`, or `$FOUNDRY_EXECUTION_SESSION_ROOT/claude-settings/…` in an Issue sandbox. 0600; lives until the turn's lease is released, and a dead owner's files are reaped at startup | Flag-tier settings for workspace turns and provider checks (`acquireClaudeSettings`)                | API connection key (`ANTHROPIC_AUTH_TOKEN`) plus endpoint | No credential. Removed: names on Claude Code's credential list (`ANTHROPIC_*_KEY/TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_*`, `OPENAI_API_KEY`, `CODEX_API_KEY`, …), anything named like a credential (`TOKEN` but not `TOKENS`, `SECRET`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, …), and any value that contains such a credential (headers, URLs carrying a key) |
| Codex execution home `config.toml`                                                                                                                                                                                          | The person's own config.toml plus `sqlite_home` and `cli_auth_credentials_store = "ephemeral"`      | No Foundry credential                                     | Unchanged. The key travels in `CODEX_API_KEY` (env) through `env_key`. Process argv `-c model_providers.<id>` carries only fields from a non-secret allowlist; headers and bearer tokens go over the app-server's JSON-RPC, in memory                                                                                                                                          |
| Issue sandbox `CLAUDE_CONFIG_DIR/.credentials.json`, `CODEX_HOME/auth.json` (`provider-credentials.ts`)                                                                                                                     | Copy of the device's own login, access token only, no refresh token; removed when the sandbox stops | Same                                                      | Unchanged. It exposes no more than the device's own `~/.claude/.credentials.json` / `~/.codex/auth.json`, which every agent of this OS user can already read                                                                                                                                                                                                                   |
| External connections (`external-connection.ts`)                                                                                                                                                                             | The helper gets settings and request over stdin; its temp directory is deleted on release           | No key on disk                                            | Unchanged                                                                                                                                                                                                                                                                                                                                                                      |
| Connector tool configs (gh, feishu-cli `token.json` / gateway handles, ghcr helper, AWS)                                                                                                                                    | What the agent's own tools log in with                                                              | By design: the agent uses these tools                     | Not in scope here; recorded as an open item                                                                                                                                                                                                                                                                                                                                    |
| Worker profile stores (`agent-profiles.local.json`, `extension-model-providers.json`, `external-account-profiles.json`)                                                                                                     | Checked on sg-chaos                                                                                 | No key fields                                             | Unchanged                                                                                                                                                                                                                                                                                                                                                                      |

- Echoes: the server DB on sg-chaos holds this key only in a message the person pasted themselves on 11-09 (sess_1794143153454726480, `agent_session_events` + `evidence_requests`). The Foundry event stream for the 08:50 tool output was redacted and did not store the key. **The native Claude transcript holds it raw**: `~/.foundry/connection-data/353d…/claude/projects/-home-windeng-workspace-foundry/b2a82174-0c3b-4720-a15a-7ae66f812cc9.jsonl` on sg-chaos (2 occurrences, file 0600).

## Fix

[session-launch-options.ts](../../packages/worker/src/session/session-launch-options.ts):

- `acquireClaudeSettings` writes `withoutCredentials(settings)`: every caller (turns, provider checks) goes through this one boundary. `claudeSettingsEnvironment` is the filter.
- `clearClaudeSettingsFiles`, already called at daemon start and execution-host takeover, now also calls `removeCredentialsFromSettingsFiles`. It rewrites in place, atomically, any `<sha>.json` an older Worker left with a credential in it. A running Claude process keeps its file, and its key stays in its own environment, so running sessions are not affected.

Tests ([claude-launch-secrets.test.mjs](../../packages/worker/test/claude-launch-secrets.test.mjs)):

- A settings file contains neither the key's name nor its value.
- The filter removes credentials by name and inside other values, and keeps `*_TOKENS` counts, models and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`.
- Two sessions' files contain neither session's key.
- A legacy file is cleaned and stays 0600; files outside the `<sha>.json` naming are not touched.

## Deployment

- Worker `0.5.7-dev.357.g8f394c91.local.1794566569`. The shared tree has unreleased work, so this is not built from the tree: it is the live `…local.1794563196` (DEV-213) package with only `dist/session/session-launch-options.js` replaced. That compiled file was diffed line by line against the live one, and the difference is exactly this change. Deployed with `deploy-dev.sh --prebuilt … --label dev221 --worker`. Rollback: `release.json.pre-dev221`. Patch for the release train (base HEAD 8f394c91 + uncommitted DEV-213): `~/.foundry/devlog-evidence/dev221/DEV-221.patch` on sg-chaos.
- Updated through update_worker: sg-chaos, byte-dev, cottoncpp, limen-canada. **Still on the old version**: byte-dev-sg (update failed while downloading: `terminated`), macbook (offline when the update started), CanWendeMac-mini (offline). After this deploy, the orchestrator ruled that only the train conductor sess_1794555762602239151 deploys and runs update_worker; those three devices were handed to it.

## Checks

- Worker tsc is clean. On sg-chaos, `run-worker-tests.mjs`: claude-launch-secrets 10/10, session-launch-options and native-instruction-files all pass. external-connection 21/23: the 2 failing helper-timing tests (1-second deadlines) fail the same way on the unchanged tree under sg-chaos load, which was around 12.
- Real sessions on sg-chaos with the new Worker, both answered:
  - sess_1794567037046568177 (Tencent TokenHub (Claude)): settings env keys are `ANTHROPIC_API_BASE_URL, ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_*_MODEL, ANTHROPIC_MODEL, CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, CLAUDE_CODE_SUBAGENT_MODEL, DISABLE_AUTOUPDATER, FOUNDRY_AGENT_MODEL`, with no `ANTHROPIC_AUTH_TOKEN`.
  - sess_1794567039702091141 (Limen · default): `ANTHROPIC_MODEL, DISABLE_AUTOUPDATER, FOUNDRY_AGENT_MODEL`.
- Settings files on the devices: none with a key on sg-chaos (8 files), limen-canada (0) or cottoncpp (1). byte-dev's compute lease was taken, so it was not checked.

## Limitations (same OS user)

- **A process's environment can be read by the same user.** On Linux any process of the same user can read `/proc/<pid>/environ` (Yama only restricts ptrace attach), and on macOS `ps eww` shows the same thing. When this was checked, one running Claude process on sg-chaos had `ANTHROPIC_AUTH_TOKEN` in its environ. So one session can still get another's key on purpose. It can no longer turn up in a casual `cat`/`grep` of a config folder.
- The agent's own Bash: in the TokenHub session, `printenv ANTHROPIC_AUTH_TOKEN` was empty, because Claude Code under host mode does not hand the provider credential to its subprocesses. But `/proc/$PPID/environ` still has it. Codex has `shell_environment_policy` and defaults that drop `*KEY*`/`*TOKEN*` names (this is not guaranteed across versions), and `/proc` reads the same way.
- Further options, which are trade-offs for the person to choose:
  - Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: on Linux, Bash runs in its own PID namespace and cannot see other processes' `/proc`. But it also removes connector credentials from subprocesses and breaks `ps`/`kill` on host processes.
  - Hand the key over through a file descriptor (`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`). That is x-api-key semantics and needs gateway-compatibility checks.
  - Run sessions as separate OS users or in a sandbox.
- Not covered by the in-place cleanup: files under an Issue sandbox's own `FOUNDRY_EXECUTION_SESSION_ROOT`, which are deleted along with the sandbox.
- **My own exposure during this investigation:** to locate echoes, a `grep -F -e <key>` scan ran on sg-chaos for about 25 minutes (roughly 10:33–10:58 UTC). During that time the key was in that process's argv, and anyone on the machine could read it with `ps`. The scan was then stopped, and the temporary key file was deleted.

## Exposure and rotation

The Tencent TokenHub (Claude) key (`prof_2c4c55cc-…`) has been seen or could be read by:

- the person and anyone who can read the native transcript of sess_1794559698135735487 on sg-chaos (the dev foundry workspace);
- any process or agent running as `windeng` on sg-chaos, which is shared with e2e-alice;
- local users on sg-chaos during the argv window above;
- the person's own message of 11-09, stored in plaintext in the dev server DB.

**Rotation is recommended. The person decides; it was not rotated.** After rotating, redact the two occurrences in the native transcript or delete that transcript. That is the person's data and was not changed.

## Acceptance

1. In a session using an API connection (e.g. TokenHub (Claude)), run `S=$(tr '\0' '\n' < /proc/$PPID/cmdline | grep -A1 -- '^--settings$' | tail -1); grep -c AUTH_TOKEN "$S"`. Expected: `0`, and the session still answers.
2. On byte-dev-sg, macbook and CanWendeMac-mini, once updated to ≥1794566569: `grep -rlE '"ANTHROPIC_(AUTH_TOKEN|API_KEY)": *"[^"]{8,}' ~/.foundry/claude-settings` finds nothing.

## Timeline

- 2026-11-13: investigation, fix, targeted tests and release (above). Not committed.
