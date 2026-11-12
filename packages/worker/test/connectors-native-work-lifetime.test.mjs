// DEV-155: what a run sets up for its session's connectors (the feishu-cli
// profile, forwarders, the tool folder) outlives the Foundry turn: a command
// Claude moved to the background, a turn it starts on a task's notification
// or a timer, a Codex goal. It lives as long as the session's agent process
// does (session-environment-agent-lifetime.test.mjs). The worker claims the
// sessions whose agents work on their own to the server, which keeps their
// grants live meanwhile.
import "./fixtures/native-test-homes.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeSessionAccounts,
  reapExternalAccountProfiles,
  sessionExternalAccountEnvironment,
} from "../dist/connectors/feishu.js";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
  SessionExecutionRegistry,
} from "../dist/session/session-state.js";
import {
  holdWhileAgentRuns,
  sessionHasNativeWork,
  sessionsWithNativeWork,
  sweepAgentEnvironmentHolds,
} from "../dist/session/runner/active-runtimes.js";
import { daemonHeartbeat } from "../dist/daemon/control-connection.js";
import {
  prepareSessionTools,
  sessionToolsFolder,
} from "../dist/skills/session-tools.js";
import { ReliableSessionTransport } from "../dist/transport/transport.js";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "fdy-native-work-"));
  return {
    home: join(root, "home"),
    manifestPath: join(root, "state", "external-account-profiles.json"),
    forwarder: async () => ({ baseURL: "http://127.0.0.1:45678" }),
  };
}

const handles = (n) => ({
  path: "/api/feishu-gw",
  appHandle: `fsg_app${n}`.padEnd(40, "x"),
  userHandle: `fsu_user${n}`.padEnd(40, "x"),
  refreshHandle: `fsr_refresh${n}`.padEnd(40, "x"),
});

function material(n) {
  return {
    accountId: "xacc_one",
    provider: "feishu",
    label: "Work Feishu",
    tool: "feishu-cli",
    profileName: "foundry-one-5e55104e00",
    clientId: "cli_app",
    gateway: handles(n),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: "docx:document",
  };
}

const profileDir = (paths) =>
  join(paths.home, ".feishu-cli", "profiles", "foundry-one-5e55104e00");
const userToken = (paths) =>
  JSON.parse(readFileSync(join(profileDir(paths), "token.json"), "utf8"))
    .access_token;

/**
 * A Claude process of the session as active-runtimes sees it: background
 * tasks, timers and a turn it continues by itself are its own work.
 */
function claudeRuntime(sessionId, work = {}) {
  const runtime = {
    key: `key-${sessionId}`,
    foundrySessionId: sessionId,
    nativeSessionId: `native-${sessionId}`,
    closed: false,
    continuation: work.continuation,
    background: { hasRunning: () => Boolean(work.background) },
    timers: { snapshot: () => (work.timer ? [{ id: "t1" }] : []) },
  };
  activeClaudeRuntimes.set(runtime.key, runtime);
  return {
    set: (next) => Object.assign(work, next),
    continue: (value) => (runtime.continuation = value),
    close: () => activeClaudeRuntimes.delete(runtime.key),
  };
}

test("a background command that outlives the turn keeps the session's feishu-cli profile", async (t) => {
  const paths = scratch();
  const session = { id: "sess_bg" };
  const runtime = claudeRuntime(session.id, { background: true });
  t.after(runtime.close);
  const prepared = await materializeSessionAccounts(
    session,
    [material(1)],
    paths,
  );
  // A loop the agent started in the background reads its profile every
  // 40 ms, the way each feishu-cli call does, for longer than the turn.
  const reads = spawn(
    "sh",
    [
      "-c",
      'i=0; ok=0; while [ $i -lt 15 ]; do [ -f "$HOME/.feishu-cli/profiles/$FEISHU_PROFILE/token.json" ] && ok=$((ok+1)); i=$((i+1)); sleep 0.04; done; echo $ok',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: paths.home,
        ...sessionExternalAccountEnvironment(session.id),
      },
    },
  );
  let out = "";
  reads.stdout.on("data", (chunk) => (out += chunk));
  // The turn ends with the loop still running.
  holdWhileAgentRuns(session.id, prepared.release);
  await new Promise((resolve) => reads.on("exit", resolve));
  assert.equal(out.trim(), "15", "every read after the turn found the profile");
  assert.deepEqual(sessionExternalAccountEnvironment(session.id), {
    FEISHU_PROFILE: "foundry-one-5e55104e00",
  });

  // The loop ends; the idle process keeps the profile (it may still pick
  // up the task's notification), which goes when the process exits.
  runtime.set({ background: false });
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(profileDir(paths)), true);
  runtime.close();
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(profileDir(paths)), false);
  assert.deepEqual(sessionExternalAccountEnvironment(session.id), {});
});

test("a turn without native work releases at once, as before", async () => {
  const paths = scratch();
  const prepared = await materializeSessionAccounts(
    { id: "sess_plain" },
    [material(1)],
    paths,
  );
  holdWhileAgentRuns("sess_plain", prepared.release);
  assert.equal(existsSync(profileDir(paths)), false);
});

test("a turn the agent's notification or timer starts finds the environment", async (t) => {
  const paths = scratch();
  const session = { id: "sess_wake" };
  const runtime = claudeRuntime(session.id, { timer: true });
  t.after(runtime.close);
  const prepared = await materializeSessionAccounts(
    session,
    [material(1)],
    paths,
  );
  holdWhileAgentRuns(session.id, prepared.release);
  // A ScheduleWakeup pending, then the turn Claude runs when it fires.
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(profileDir(paths)), true);
  runtime.set({ timer: false });
  runtime.continue({ turn: "own" });
  assert.equal(sessionHasNativeWork(session.id), true);
  sweepAgentEnvironmentHolds();
  assert.equal(userToken(paths), handles(1).userHandle);
  runtime.continue(undefined);
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(profileDir(paths)), true);
  runtime.close();
  sweepAgentEnvironmentHolds();
  assert.equal(existsSync(profileDir(paths)), false);
});

test("a newer run of the session takes over the profile; the held run's end leaves it", async (t) => {
  const paths = scratch();
  const session = { id: "sess_two_runs" };
  const runtime = claudeRuntime(session.id, { background: true });
  t.after(runtime.close);
  const first = await materializeSessionAccounts(session, [material(1)], paths);
  holdWhileAgentRuns(session.id, first.release);
  // The person's next message: a new run with fresh handles, on the same
  // process, whose background work the first run left going.
  const second = await materializeSessionAccounts(
    session,
    [material(2)],
    paths,
  );
  assert.equal(userToken(paths), handles(2).userHandle);
  // The process ends; the first run's hold is released.
  runtime.close();
  sweepAgentEnvironmentHolds();
  assert.equal(
    userToken(paths),
    handles(2).userHandle,
    "the first run's release left the second run's profile",
  );
  assert.deepEqual(sessionExternalAccountEnvironment(session.id), {
    FEISHU_PROFILE: "foundry-one-5e55104e00",
  });
  second.release();
  assert.equal(existsSync(profileDir(paths)), false);
  assert.deepEqual(sessionExternalAccountEnvironment(session.id), {});
});

test("a held profile is live: a reap in its own process leaves it", async (t) => {
  const paths = scratch();
  const runtime = claudeRuntime("sess_reap", { background: true });
  t.after(runtime.close);
  const prepared = await materializeSessionAccounts(
    { id: "sess_reap" },
    [material(1)],
    paths,
  );
  holdWhileAgentRuns("sess_reap", prepared.release);
  assert.deepEqual(
    reapExternalAccountProfiles({ manifestPath: paths.manifestPath }),
    [],
  );
  assert.equal(existsSync(profileDir(paths)), true);
  runtime.close();
  sweepAgentEnvironmentHolds();
});

test("a kept Codex app-server's own work holds the session too", () => {
  let busy = true;
  activeCodexThreads.set("codex-key", {
    key: "codex-key",
    lastUsed: Date.now(),
    sessionId: "sess_goal",
    nativeSessionId: "thread_1",
    thread: { isBusy: () => busy },
  });
  try {
    assert.deepEqual(sessionsWithNativeWork(), ["sess_goal"]);
    busy = false;
    assert.deepEqual(sessionsWithNativeWork(), []);
  } finally {
    activeCodexThreads.delete("codex-key");
  }
});

test("the heartbeat claims the sessions whose agents work on their own", (t) => {
  const sessionExecutions = new SessionExecutionRegistry();
  const sessionTransport = new ReliableSessionTransport();
  assert.equal(
    "nativeWorkSessionIds" in
      daemonHeartbeat({ sessionExecutions, sessionTransport }),
    false,
  );
  // The execution host's snapshot, and a process of this worker.
  sessionExecutions.setNativeWork(["sess_host"]);
  const runtime = claudeRuntime("sess_local", { background: true });
  t.after(runtime.close);
  assert.deepEqual(
    daemonHeartbeat({ sessionExecutions, sessionTransport })
      .nativeWorkSessionIds,
    ["sess_host", "sess_local"],
  );
  runtime.set({ background: false });
  sessionExecutions.setNativeWork([]);
  assert.equal(
    "nativeWorkSessionIds" in
      daemonHeartbeat({ sessionExecutions, sessionTransport }),
    false,
  );
});

test("a newer run's tool folder survives the held run's release", () => {
  const first = prepareSessionTools("sess_tools", []);
  const folder = sessionToolsFolder("sess_tools");
  assert.ok(folder && existsSync(folder));
  const second = prepareSessionTools("sess_tools", []);
  first.release();
  assert.equal(sessionToolsFolder("sess_tools"), folder);
  assert.equal(existsSync(folder), true);
  second.release();
  assert.equal(sessionToolsFolder("sess_tools"), undefined);
  assert.equal(existsSync(folder), false);
});
