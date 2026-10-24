# Foundry errors and session states

What a session's `status`, `error`, `lastError` and events mean.

- "Claude Agent SDK stopped producing events before the session idle timeout"
  comes from older workers, which failed a turn after 10 minutes without
  events. If "Waiting for background tasks" comes just before it, a background
  task (a Monitor, a `run_in_background` command) kept the turn open: see
  `openBackgroundTasks` and the "Starting subtask" events. Current workers
  never fail a turn for being quiet: a "Notice" saying there was no progress,
  or that an operation ran past its limit, is a warning while the turn keeps
  running. "Claude Code did not start" or "never reached the model" is a
  start-up hang; the message names the phase and quotes Claude Code's output.
- "Subtask failed" errors are background tasks ending badly; they rarely end a
  session on their own.
- "Session canceled" (a warning) means someone stopped it.
- `blocked` means its device reported a wait, such as a rate-limited model; it
  is still active and can be steered or stopped.
- "There's an issue with the selected model" or 404/401 from a model
  service: `list_profiles` on the session's device shows the profile its
  summary names, with its `baseUrl`, models and whether a key is stored, and
  `list_models` its endpoint's catalog. Claude Code appends `/v1/messages` to
  the base URL, so a Claude base ends without `/v1`; a Codex base ends with
  its version (`/v1`). Foundry corrects these when a service is saved. Do not
  send requests to the endpoint yourself; ask the person to fix the service.
- `device.online: false` or "local daemon is not connected": the device's
  worker is offline; `list_resources` shows which devices are online.
- A long gap between the last events and `completedAt` is a wait, not work.
- A native chat (`native_claude_…`, `native_codex_…`) is a conversation the
  person ran in a terminal on their device; Foundry syncs its transcript, read
  with scope `events` or `transcript`, and cannot message or stop it.
