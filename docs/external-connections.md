# Device-owned external model connections

Foundry can use a device-installed connection helper while keeping the native Claude Agent SDK, CLI, tools, permissions and history. The connection is selected like other device profiles. It is not an API base URL and cannot be promoted to a server model service. The initial implementation supports Claude; other runtimes are not advertised as supported.

The public repository has no dependency on any private gateway. A gateway may ship its own helper implementing the protocol below. Installers and account onboarding belong to that gateway. Foundry does not download helpers or run commands supplied by a workspace.

## Configuration

A gateway's installer registers its connection with `foundry-worker connection add` (see [Installer registration](#installer-registration)). The command writes a profile like this to the device owner's `~/.foundry/agent-profiles.local.json` and keeps the other profiles:

```json
{
  "profiles": [
    {
      "id": "company_connection",
      "label": "Company connection",
      "runtime": "claude",
      "connectionType": "external",
      "model": "sonnet",
      "models": ["sonnet", "opus", "haiku"],
      "externalConnection": {
        "executable": "/absolute/path/to/connection-helper",
        "args": ["work"],
        "identity": "opaque-verified-connection-identity"
      }
    }
  ]
}
```

Executable and arguments are local configuration, never shell text or secrets. The helper must provide an authenticated non-secret identity during onboarding. It must verify that identity again before every native process starts. A change of gateway/account must produce a different identity; update the profile deliberately and start a new conversation. Each external profile/identity has separate native history under `~/.foundry/connection-data`.

Explicitly check the installed profile with `foundry-worker connection check company_connection`, or with **Check** on the Devices page. This uses one short native SDK conversation and model quota; it never runs automatically. Only a passed inference check makes it selectable; a local configuration or gateway handshake is not proof of inference. The Devices page shows each connection as helper missing, not checked, check failed (with the reason) or ready. Its owner can **Check** or **Remove** it there if the device's worker declares `external_connection_manage_v1`. Remove deletes only that external entry and its check result. Configured model names are selectable; Foundry does not send `/models` to a local proxy or read the unrelated local login's model catalog.

## Installer registration

Foundry does not download or install helpers. The gateway's own installer puts its helper on the device, onboards the account, and then registers the connection. It must call the `foundry-worker` of the device owner's account (the same `HOME` / `FOUNDRY_STATE_ROOT` the worker service uses):

```sh
foundry-worker connection add company_connection \
  --label "Company connection" \
  --executable /absolute/path/to/connection-helper \
  --arg work --arg=--profile=default \
  --identity opaque-verified-connection-identity \
  --model sonnet --models sonnet,opus,haiku
foundry-worker connection list --json
foundry-worker connection remove company_connection
```

- The id is 1–64 lowercase letters, digits and single underscores. `--arg` is repeatable and literal; never pass shell text. Write a value that starts with `-` as `--arg=<value>`. `--models` is comma-separated, and the default `--model` is always included. Validation is the same check the runtime applies before every launch: an absolute path to an existing executable file, a non-empty identity of at most 512 characters, and at most 32 arguments.
- **Idempotent.** The same input again returns `"action":"unchanged"` and leaves the file alone. A changed label, models, helper path, arguments, identity or default model updates the entry in place (`"updated"`). It keeps any other fields a person added, including turning the connection off (`"enabled": false`). A changed helper, identity or model no longer matches the stored check fingerprint, so the connection reads as not checked until someone checks it explicitly. Registration never runs a check.
- **Never touches other profiles.** The file is rewritten atomically with mode 0600. Every other profile, disabled entries and unknown top-level keys are preserved. An id already used by a non-external profile is refused, whether it's a profile in the file, a profile discovered in the native agent configuration, or a built-in login such as `claude_local`. `remove` deletes only an external entry, and is refused with `busy` while that connection is being checked.
- The running worker notices the change within one heartbeat (about 25 seconds) and reports it without a restart.

`add` and `remove` print one JSON line on stdout:

```json
{
  "ok": true,
  "action": "created",
  "profileId": "company_connection",
  "connection": {
    "id": "company_connection",
    "label": "Company connection",
    "runtime": "claude",
    "model": "sonnet",
    "models": ["sonnet", "opus", "haiku"],
    "executable": "/absolute/path/to/connection-helper",
    "args": ["work", "--profile=default"],
    "identity": "opaque-verified-connection-identity",
    "helperAvailable": true,
    "check": { "status": "unchecked" }
  }
}
```

`action` is `created`, `updated`, `unchanged` or `removed` (a removal has no `connection`). `connection list --json` prints an array of the same `connection` objects. Without `--json` it prints one tab-separated line per connection: id, status (`unchecked` / `passed` / `failed` / `helper_missing`), model and label. A refusal prints `{"ok":false,"code":"…","error":"…"}` on stdout and the message on stderr.

| Exit | Code            | Meaning                                                                                                  |
| ---- | --------------- | -------------------------------------------------------------------------------------------------------- |
| 0    | —               | Done (including `unchanged`)                                                                             |
| 1    | —               | Unexpected failure, e.g. an unreadable file; `connection check` also exits 1 when the check did not pass |
| 2    | `invalid_input` | Invalid id, label, model, helper path, identity or arguments; or a malformed profiles file               |
| 3    | `id_conflict`   | The id belongs to a profile that is not an external connection                                           |
| 4    | `not_found`     | No external connection with that id (`remove`, `check`)                                                  |
| 5    | `busy`          | That connection is already being checked by this process                                                 |

Command-line usage errors (unknown option, missing value) use the general `foundry-worker` error format and exit 2.

## Private process protocol v1

Foundry starts the executable with literal arguments and sends one JSON line on stdin:

```json
{
  "protocol": "foundry.connection.v1",
  "runtime": "claude",
  "identity": "opaque-verified-connection-identity",
  "cwd": "/workspace",
  "configHome": "/private/generated/claude-home",
  "settings": "/private/generated/settings.json",
  "environment": { "ANTHROPIC_MODEL": "sonnet" }
}
```

`settings` may also be a JSON object or absent. `environment` contains model/connection metadata after inherited provider credentials and endpoint overrides have been removed. The helper process receives only basic OS lookup variables and starts in a private temporary directory, never the workspace. Settings are sent as a validated snapshot; a settings snapshot containing inherited provider credentials or endpoint overrides is rejected before helper launch. The helper checks settings conflicts and prepares the connection; it must not change the host's settings, credential home, executable, tools, Skills or MCP configuration. A public certificate needed by a sandboxed CLI can be written inside the provided config home and removed on release.

The helper replies with one JSON line on stdout, then stays alive:

```json
{
  "protocol": "foundry.connection.v1",
  "identity": "opaque-verified-connection-identity",
  "environment": {
    "unset": ["ANTHROPIC_API_KEY"],
    "set": {
      "HTTPS_PROXY": "http://127.0.0.1:12345",
      "NODE_EXTRA_CA_CERTS": "/private/generated/claude-home/connection-ca.pem",
      "CLAUDE_CODE_OAUTH_TOKEN": "invocation-only-credential"
    }
  }
}
```

The reply and credentials stay in memory, are never logged, and cannot be used to overwrite Foundry configuration or executable-loading variables. Known invocation credentials are registered with transcript redaction. Helper stderr is not forwarded because arbitrary provider diagnostics may contain credentials. Response size is bounded to 256 KiB and preparation defaults to 15 seconds.

Foundry applies only the helper's explicit environment assignments to the cleaned base and starts the original CLI through the SDK. It appends its control-plane hostname to both NO_PROXY and no_proxy so its MCP bearer traffic bypasses the model proxy. The helper's stdin remains open for the native process lifetime, including multiple conversation turns. EOF means release. The helper must remove its temporary resources and exit; Foundry force-stops an unresponsive helper and closes its pipes after two seconds, bounding cleanup even if an escaped descendant retained stdio. If the helper exits unexpectedly, Foundry cancels the native query. Cancellation lets the native CLI finish its normal shutdown before releasing the helper. A failed preparation never falls back to another account.

Workspace sandboxes prepare their connection on the host and receive only the invocation environment; the helper's credential store is not mounted into the sandbox. The host prepares the exact native config home used inside the sandbox and validates its owner, runtime and workspace before reuse. Independent judgments likewise prepare outside the native CLI sandbox. These are application lifecycle guarantees, not isolation between people sharing an unrestricted OS account.

## Compatibility obligations

- The helper owns connection credentials, proxy/TLS preparation and connection policy. Foundry owns native process launch, configuration isolation, permissions, history and cancellation.
- Changes to inherited proxy/CA/region variables can affect tools and MCP subprocesses. Verify these paths with the gateway before shipping an adapter.
- A helper must state runtime/version restrictions and disabled native features. SDK support alone does not establish gateway compatibility.
- Acceptance includes streaming, native tool calls, resume, cancellation, concurrent sessions, identity mismatch and sandbox execution. Test helpers need no real gateway or credentials.

Limen is an optional private implementation of this contract. Its source and release artifacts are maintained outside the Foundry repository; its CONNECT protocol, CA trust, account mapping and runtime checks remain Limen's responsibility.
