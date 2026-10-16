import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { processIdentity } from "../dist/agent-processes.js";
import { ExecutionHostClient } from "../dist/execution-host/client.js";
import { SessionExecutionRegistry } from "../dist/session-state.js";
import { ReliableSessionTransport } from "../dist/transport.js";
import { executionHostPaths } from "../dist/execution-host/paths.js";
import { runtimeStamp } from "../dist/execution-host/service.js";
import { FileSessionOutbox } from "../dist/session-outbox-store.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await pause(30);
  }
  throw new Error("condition not met");
}
test("disk outbox retains original identities until server acknowledgement", () => {
  const root = mkdtempSync(join(tmpdir(), "host-outbox-"));
  try {
    const store = new FileSessionOutbox(root);
    const one = new ReliableSessionTransport({ store });
    const id = one.send("session_completed", {
      sessionId: "s",
      response: "done",
    });
    const two = new ReliableSessionTransport({ store });
    assert.equal(two.pendingCount(), 1);
    assert.equal(store.read()[0].id, id);
    two.acknowledge(id);
    assert.equal(new ReliableSessionTransport({ store }).pendingCount(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("host keeps execution through worker disconnect, suppresses duplicate dispatch and replays output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-integration-"));
  const state = join(
    root,
    process.platform === "darwin" ? "state-" + "x".repeat(90) : "state",
  );
  const hostRoot = join(state, "execution-host");
  const workspace = join(root, "workspace");
  const paths = executionHostPaths(hostRoot);
  const socket = paths.socket;
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(hostRoot, "token"), "test-auth", { mode: 0o600 });
  const native = join(root, "codex");
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        account_id: "host-test-account",
        access_token: "host-test-access",
        id_token: "host-test-id",
        refresh_token: "host-test-refresh",
      },
    }),
    { mode: 0o600 },
  );
  const count = join(root, "starts");
  writeFileSync(
    native,
    `#!${process.execPath}
const {appendFileSync,writeFileSync}=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const reply=result=>send({id:r.id,result});
if(r.method==='initialize'||r.method==='account/login/start')return reply({});if(r.method==='skills/list')return reply({data:[{skills:[],errors:[]}]});
if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:'native-host'}});
if(r.method==='turn/start'){writeFileSync(${JSON.stringify(count + "-env")},JSON.stringify({codexHome:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,role:process.env.FOUNDRY_SERVICE_ROLE}));appendFileSync(${JSON.stringify(count)},'start\\n');appendFileSync(${JSON.stringify(count + "-pids")},String(process.pid)+'\\n');reply({turn:{id:'turn'}});send({method:'turn/started',params:{threadId:'native-host',turn:{id:'turn'}}});return;}
if(r.method==='turn/steer'){reply({});send({method:'item/completed',params:{threadId:'native-host',turnId:'turn',item:{id:'answer',type:'agentMessage',text:'survived',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'native-host',turn:{id:'turn',status:'completed'}}});return;}
if(r.method==='turn/interrupt')reply({});});`,
    { mode: 0o700 },
  );
  const managed =
    process.env.TEST_EXECUTION_HOST_SYSTEMD === "1" ||
    process.env.TEST_EXECUTION_HOST_SERVICE === "1";
  const entry = fileURLToPath(
    new URL("../dist/execution-host/main.js", import.meta.url),
  );
  const serviceEnv = {
    ...process.env,
    FOUNDRY_STATE_ROOT: state,
    FOUNDRY_TOOLS_ROOT: join(root, "tools"),
    FOUNDRY_CODEX_BIN: native,
    HOME: root,
    CODEX_HOME: join(root, "codex-home"),
    CLAUDE_CONFIG_DIR: join(root, "claude-home"),
    FOUNDRY_STACK: `host-test-${process.pid}`,
  };
  const serviceURL = new URL(
    "../dist/execution-host/service.js",
    import.meta.url,
  ).href;
  const appURL = new URL("../dist/mac-worker-app.js", import.meta.url).href;
  const serviceControl = (action, target = entry) => {
    const script = `import {launchExecutionService,stopExecutionService} from ${JSON.stringify(serviceURL)};
    if(${JSON.stringify(action)}==='start') {
      if(process.platform==='darwin') {
        const {ensureWorkerApp,workerLauncherScript}=await import(${JSON.stringify(appURL)});
        ensureWorkerApp(workerLauncherScript(${JSON.stringify({ command: [process.execPath, "-e", "process.exit(99)"], env: {}, logs: { out: join(hostRoot, "unused.out"), err: join(hostRoot, "unused.err") } })}));
      }
      await launchExecutionService(${JSON.stringify(target)},'http://127.0.0.1:1');
    } else await stopExecutionService();`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: serviceEnv,
      timeout: 40_000,
    });
  };
  let complete = false;
  const phase = (name) => {
    if (managed) console.log("host-test phase:", name);
  };
  let host,
    stderr = "",
    first,
    second,
    worker;
  if (managed) {
    serviceControl("start");
    host = { exitCode: null };
  } else {
    host = spawn(process.execPath, [entry, "http://127.0.0.1:1"], {
      env: {
        ...process.env,
        FOUNDRY_STATE_ROOT: state,
        FOUNDRY_CODEX_BIN: native,
        HOME: root,
        CODEX_HOME: join(root, "codex-home"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    host.stderr.on("data", (d) => (stderr += d));
  }
  t.after(async () => {
    first?.close();
    await second?.shutdown();
    worker?.kill("SIGKILL");
    if (managed) {
      serviceControl("stop");
    } else {
      try {
        process.kill(-host.pid, "SIGTERM");
      } catch {}
      await pause(350);
      try {
        process.kill(-host.pid, "SIGKILL");
      } catch {}
    }
    if (complete) rmSync(root, { recursive: true, force: true });
    else {
      console.error("host-test retained:", root);
      const log = join(hostRoot, "service.err.log");
      if (existsSync(log))
        console.error(readFileSync(log, "utf8").slice(-6000));
    }
  });
  await until(() => {
    if (host.exitCode !== null) throw new Error(stderr);
    return existsSync(socket);
  });
  phase("host ready");
  const payload = {
    session: {
      id: "sess_host_test",
      workspaceId: "ws_host_test",
      threadId: "thread_host_test",
      provider: "codex",
      profileId: "codex_local",
      model: "gpt-6-astra",
      source: "chat",
      prompt: "wait",
      status: "running",
      input: { id: "input-1", prompt: "wait", attachments: [] },
    },
    sessionToken: "",
  };
  const clientURL = new URL("../dist/execution-host/client.js", import.meta.url)
    .href;
  worker = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {ExecutionHostClient} from ${JSON.stringify(clientURL)};const c=new ExecutionHostClient(${JSON.stringify(socket)},'test-auth');await c.open();await c.run(${JSON.stringify(workspace)},${JSON.stringify(payload)});process.send('ready');`,
    ],
    { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let workerError = "";
  worker.stderr.on("data", (data) => (workerError += data));
  await Promise.race([
    once(worker, "message"),
    once(worker, "exit").then(([code]) => {
      throw new Error("worker exited " + code + ": " + workerError);
    }),
  ]);
  await until(() => {
    if (host.exitCode !== null) throw new Error(stderr);
    return existsSync(count);
  });
  phase("native started");
  const identityBefore = JSON.parse(
    readFileSync(join(hostRoot, "identity.json"), "utf8"),
  );
  const nativeBefore = Number(
    readFileSync(count + "-pids", "utf8")
      .trim()
      .split("\n")
      .at(-1),
  );
  const nativeStart = processIdentity(nativeBefore)?.startTime;
  const nativeEnvironment = JSON.parse(readFileSync(count + "-env", "utf8"));
  assert.ok(
    nativeEnvironment.codexHome.startsWith(
      join(state, "native-runtime", "codex") + "/",
    ),
    "native execution uses Foundry's isolated configuration",
  );
  assert.equal(
    realpathSync(join(nativeEnvironment.codexHome, "sessions")),
    realpathSync(join(codexHome, "sessions")),
    "the selected native history remains resumable",
  );
  if (managed)
    assert.deepEqual(nativeEnvironment, {
      codexHome: nativeEnvironment.codexHome,
      claudeHome: join(root, "claude-home"),
    });
  first = new ExecutionHostClient(socket, "test-auth");
  await assert.rejects(first.open(), /Another live worker/);
  first.close();
  phase("live owner refused");
  worker.kill("SIGKILL");
  await once(worker, "exit");
  await pause(75);
  let nextEntry;
  let target;
  if (managed) {
    const nextPackage = join(root, "next-worker");
    cpSync(
      fileURLToPath(new URL("../dist", import.meta.url)),
      join(nextPackage, "dist"),
      { recursive: true },
    );
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(nextPackage, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(nextPackage, "package.json"),
      JSON.stringify({
        type: "module",
        name: "@bd777/foundry-worker",
        version: "test-next",
      }),
    );
    nextEntry = join(nextPackage, "dist/execution-host/main.js");
    target = {
      entry: nextEntry,
      stamp: runtimeStamp(nextEntry),
      start: async () => serviceControl("start", nextEntry),
      stop: async () => serviceControl("stop"),
      legacyAlone: () => false,
    };
  }
  second = new ExecutionHostClient(
    socket,
    "test-auth",
    "http://127.0.0.1:1",
    target,
  );
  const received = [];
  const transport = new ReliableSessionTransport();
  transport.bind({
    readyState: 1,
    send: (data) => received.push(JSON.parse(data)),
  });
  const registry2 = new SessionExecutionRegistry();
  second.attach(transport, registry2);
  await second.open();
  phase("owner reattached");
  assert.equal(
    JSON.parse(readFileSync(join(hostRoot, "identity.json"), "utf8")).pid,
    identityBefore.pid,
  );
  assert.equal(
    processIdentity(nativeBefore)?.startTime,
    nativeStart,
    "the same native process survives Worker replacement",
  );
  assert.equal(second.owns("sess_host_test", "input-1"), true);
  const oldIdentity = JSON.parse(
    readFileSync(join(hostRoot, "identity.json"), "utf8"),
  );
  await second.refresh();
  assert.equal(
    JSON.parse(readFileSync(join(hostRoot, "identity.json"), "utf8")).pid,
    oldIdentity.pid,
    "busy service must not be upgraded",
  );
  await second.run(workspace, payload);
  assert.equal(readFileSync(count, "utf8"), "start\n");
  phase("busy upgrade deferred");
  await second.steer("sess_host_test", "steer-1", "finish", []);
  await until(() => received.some((e) => e.type === "session_completed"));
  phase("native completed");
  assert.equal(
    received.find((e) => e.type === "session_completed").payload.response,
    "survived",
  );
  assert.ok(received.some((e) => e.type === "session_started"));
  await second.refresh();
  assert.deepEqual(registry2.activeSessionIds(), []);
  if (managed) {
    await until(async () => {
      await second.refresh();
      return (
        JSON.parse(readFileSync(join(hostRoot, "identity.json"), "utf8"))
          .entry === nextEntry
      );
    });
    assert.notEqual(
      JSON.parse(readFileSync(join(hostRoot, "identity.json"), "utf8")).pid,
      oldIdentity.pid,
      "idle service upgrades to the new runtime",
    );
    phase("idle upgrade finished");
    const next = {
      ...payload,
      session: {
        ...payload.session,
        input: { ...payload.session.input, id: "input-2" },
      },
    };
    await second.run(workspace, next);
    await until(() => readFileSync(count, "utf8").split("start").length === 3);
    const nativePid = Number(
      readFileSync(count + "-pids", "utf8")
        .trim()
        .split("\n")
        .at(-1),
    );
    assert.ok(processIdentity(nativePid));
    const crashed = JSON.parse(
      readFileSync(join(hostRoot, "identity.json"), "utf8"),
    ).pid;
    phase("killing execution host");
    process.kill(crashed, "SIGKILL");
    await until(() => !processIdentity(nativePid));
    await until(async () => {
      try {
        await second.refresh();
        return !second.owns("sess_host_test", "input-2");
      } catch {
        return false;
      }
    });
    await until(() =>
      received.some(
        (e) =>
          e.type === "session_completed" &&
          e.payload.inputId === "input-2" &&
          e.payload.error,
      ),
    );
    assert.equal(
      readFileSync(count, "utf8"),
      "start\nstart\n",
      "a crashed host must never silently rerun a native turn",
    );
  }
  const bad = new ExecutionHostClient(socket, "wrong");
  await assert.rejects(bad.open(), /authentication/);
  bad.close();
  complete = true;
});
