// A session's command environment on the device (its session-bin folder of
// connector launchers, its tool version folder, its connector variables and
// forwarders) lives as long as the session's agent process does, idle or
// not: a turn the agent starts by itself after it was idle (a background
// task's notification, a timer) still finds its commands. It goes when the
// process exits, or at once when the session fails or is canceled. Each call
// through it is still authorized by the server (gateway.SessionLive).
import "./fixtures/native-test-homes.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  prepareSessionConnectors,
  withSessionConnectors,
} from "../dist/connectors/index.js";
import { managedToolsBin } from "../dist/skills/managed-tools.js";
import {
  prepareSessionTools,
  sessionToolsFolder,
} from "../dist/skills/session-tools.js";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
} from "../dist/session/session-state.js";
import {
  holdWhileAgentRuns,
  releaseAgentEnvironment,
  sessionHasNativeWork,
  sweepAgentEnvironmentHolds,
} from "../dist/session/runner/active-runtimes.js";
import { runAgentSession } from "../dist/daemon/session-run.js";
import { cancelActiveSession } from "../dist/session/session-control.js";
import { ReliableSessionTransport } from "../dist/transport/transport.js";

// A connector command Foundry manages, as an installed tool version would be.
const command = "demo-tool";
mkdirSync(managedToolsBin(), { recursive: true });
writeFileSync(join(managedToolsBin(), command), "#!/bin/sh\necho ok\n");
chmodSync(join(managedToolsBin(), command), 0o755);
const use = {
  kind: "demo",
  adapter: "extension:demo",
  label: "Demo",
  command,
  access: "device_login",
};

/** A Claude process of the session as active-runtimes sees it. */
function claudeRuntime(sessionId, work = {}) {
  const runtime = {
    key: `key-${sessionId}`,
    foundrySessionId: sessionId,
    nativeSessionId: `native-${sessionId}`,
    closed: false,
    continuation: work.continuation,
    background: { hasRunning: () => Boolean(work.background) },
    timers: { snapshot: () => [] },
  };
  activeClaudeRuntimes.set(runtime.key, runtime);
  return {
    set: (next) => Object.assign(work, next),
    continue: (value) => (runtime.continuation = value),
    exit: () => activeClaudeRuntimes.delete(runtime.key),
  };
}

/** What one run sets up: the connector launchers and the tool folder. */
async function prepareRun(sessionId) {
  const connectors = await prepareSessionConnectors(
    { id: sessionId },
    { deviceConnectors: [use] },
  );
  const tools = prepareSessionTools(sessionId, []);
  return () => {
    connectors.release();
    tools.release();
  };
}

/** The PATH the session's processes have, and the command they run. */
function sessionCommand(sessionId) {
  const env = withSessionConnectors(
    {
      PATH: [sessionToolsFolder(sessionId), "/usr/bin", "/bin"]
        .filter(Boolean)
        .join(delimiter),
    },
    sessionId,
  );
  const [launchers] = env.PATH.split(delimiter);
  return { env, launchers };
}

const runs = (env) =>
  execFileSync("sh", ["-c", `${command}`], { env, encoding: "utf8" }).trim();

test("an idle agent process keeps its session's commands for the turn it starts by itself", async (t) => {
  const sessionId = "sess_idle_agent";
  const runtime = claudeRuntime(sessionId, { background: true });
  t.after(runtime.exit);
  const release = await prepareRun(sessionId);
  // The process was started with this environment, as Claude is.
  const { env, launchers } = sessionCommand(sessionId);
  const tools = sessionToolsFolder(sessionId);
  assert.match(launchers, /session-bin/);
  assert.ok(tools && existsSync(tools));
  assert.equal(runs(env), "ok");

  // The turn ends with a background task, which then ends: the agent idles
  // for much longer than any grace.
  holdWhileAgentRuns(sessionId, release);
  runtime.set({ background: false });
  assert.equal(sessionHasNativeWork(sessionId), false);
  for (let i = 0; i < 5; i++) sweepAgentEnvironmentHolds();

  // The task's notification starts Claude's own turn in the same process:
  // no run_session, no new preparation. Its commands are where they were.
  runtime.continue({ turn: "own" });
  assert.equal(existsSync(launchers), true, "the session-bin folder stays");
  assert.equal(existsSync(tools), true, "the tool folder stays");
  assert.equal(runs(env), "ok");
  runtime.continue(undefined);
  runtime.exit();
  sweepAgentEnvironmentHolds();
});

test("the agent process exiting reclaims its session's commands", async () => {
  const sessionId = "sess_agent_exits";
  const runtime = claudeRuntime(sessionId);
  const release = await prepareRun(sessionId);
  const { env, launchers } = sessionCommand(sessionId);
  const tools = sessionToolsFolder(sessionId);
  holdWhileAgentRuns(sessionId, release);
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(launchers), true);

  runtime.exit();
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(launchers), false, "the session-bin folder goes");
  assert.equal(existsSync(tools), false, "the tool folder goes");
  assert.equal(sessionToolsFolder(sessionId), undefined);
  assert.deepEqual(
    withSessionConnectors({ PATH: "/usr/bin:/bin" }, sessionId),
    { PATH: "/usr/bin:/bin" },
  );
  assert.throws(() =>
    runs({ ...env, PATH: [launchers, "/usr/bin", "/bin"].join(delimiter) }),
  );
});

test("a kept Codex app-server holds its session's commands while it lives", async () => {
  const sessionId = "sess_codex_idle";
  activeCodexThreads.set("codex-idle", {
    key: "codex-idle",
    lastUsed: Date.now(),
    sessionId,
    nativeSessionId: "thread_idle",
    thread: { isBusy: () => false },
  });
  const release = await prepareRun(sessionId);
  const { launchers } = sessionCommand(sessionId);
  holdWhileAgentRuns(sessionId, release);
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(launchers), true);
  activeCodexThreads.delete("codex-idle");
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(launchers), false);
});

test("a session that fails or is canceled gives up what its agent process kept", async (t) => {
  const sessionId = "sess_canceled";
  const runtime = claudeRuntime(sessionId);
  t.after(runtime.exit);
  // An earlier completed run, held for the live process.
  const earlier = await prepareRun(sessionId);
  let earlierReleased = false;
  holdWhileAgentRuns(sessionId, () => {
    earlierReleased = true;
    earlier();
  });
  const { launchers } = sessionCommand(sessionId);
  const tools = sessionToolsFolder(sessionId);
  assert.equal(existsSync(launchers), true);

  // The next input is canceled: the run's end releases its own environment
  // and the earlier run's, though the process still lives.
  const workspace = mkdtempSync(join(tmpdir(), "fdy-agent-env-"));
  const inputId = "input_canceled";
  await cancelActiveSession(sessionId, inputId);
  await runAgentSession(
    "http://127.0.0.1:9",
    workspace,
    new ReliableSessionTransport(),
    {
      session: {
        id: sessionId,
        workspaceId: "ws_agent_env",
        role: "chat",
        provider: "claude",
        input: { id: inputId },
      },
      deviceConnectors: [use],
      toolPins: [],
    },
  );
  assert.equal(existsSync(launchers), false, "the session-bin folder goes");
  assert.equal(existsSync(tools), false, "the tool folder goes");
  assert.equal(sessionToolsFolder(sessionId), undefined);
  assert.equal(earlierReleased, true, "the earlier run's hold ended");
});

test("releasing a session's environment ends only that session's holds", async (t) => {
  const kept = claudeRuntime("sess_kept");
  const ended = claudeRuntime("sess_ended");
  t.after(() => {
    kept.exit();
    ended.exit();
    sweepAgentEnvironmentHolds();
  });
  holdWhileAgentRuns("sess_kept", await prepareRun("sess_kept"));
  holdWhileAgentRuns("sess_ended", await prepareRun("sess_ended"));
  releaseAgentEnvironment("sess_ended");
  assert.equal(existsSync(sessionCommand("sess_kept").launchers), true);
  assert.equal(sessionToolsFolder("sess_ended"), undefined);
  assert.ok(sessionToolsFolder("sess_kept"));
});
