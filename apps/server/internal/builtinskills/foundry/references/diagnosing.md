# Diagnosing a failed or stuck session

Read the summary first (`read_context {"sessionId": "…"}`), then only the
events you need.

- Start from `status`, `error` and `lastError.before`.
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
- `device.online: false` or "local daemon is not connected": the device's
  worker is offline; `list_resources` shows which devices are online.
- Compare the gap between the last events and `completedAt`: a long silence
  is a wait, not work.
- A native chat (`native_claude_…`, `native_codex_…`) is a conversation the
  person ran in a terminal on their device; Foundry syncs its transcript. Read
  it with scope `events` or `transcript`; Foundry cannot message or stop it.

Report what the events show, with their times, and say what they do not show.
