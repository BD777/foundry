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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { processIdentity } from "../dist/agent-processes.js";
import { ExecutionHostClient } from "../dist/execution-host/client.js";
import { SessionExecutionRegistry } from "../dist/session-state.js";
import { ReliableSessionTransport } from "../dist/transport.js";
import { FileSessionOutbox } from "../dist/session-outbox-store.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
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
  const state = join(root, "state");
  const hostRoot = join(state, "execution-host");
  const workspace = join(root, "workspace");
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(hostRoot, "token"), "test-auth", { mode: 0o600 });
  const native = join(root, "codex");
  const count = join(root, "starts");
  writeFileSync(
    native,
    `#!${process.execPath}
const {appendFileSync}=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const reply=result=>send({id:r.id,result});
if(r.method==='initialize')return reply({});if(r.method==='skills/list')return reply({data:[{skills:[],errors:[]}]});
if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:'native-host'}});
if(r.method==='turn/start'){appendFileSync(${JSON.stringify(count)},'start\\n');appendFileSync(${JSON.stringify(count + "-pids")},String(process.pid)+'\\n');reply({turn:{id:'turn'}});send({method:'turn/started',params:{threadId:'native-host',turn:{id:'turn'}}});return;}
if(r.method==='turn/steer'){reply({});send({method:'item/completed',params:{threadId:'native-host',turnId:'turn',item:{id:'answer',type:'agentMessage',text:'survived',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId:'native-host',turn:{id:'turn',status:'completed'}}});return;}
if(r.method==='turn/interrupt')reply({});});`,
    { mode: 0o700 },
  );
  const managed = process.env.TEST_EXECUTION_HOST_SYSTEMD === "1";
  const entry = fileURLToPath(
    new URL("../dist/execution-host/main.js", import.meta.url),
  );
  const unit = `foundry-host-test-${process.pid}-${Date.now()}`;
  let host,
    stderr = "",
    first,
    second,
    worker;
  if (managed) {
    execFileSync("systemd-run", [
      "--user",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      "--service-type=exec",
      "--property=KillMode=control-group",
      "--property=Restart=on-failure",
      "--property=RestartSec=1s",
      `--setenv=FOUNDRY_STATE_ROOT=${state}`,
      `--setenv=FOUNDRY_TOOLS_ROOT=${join(root, "tools")}`,
      `--setenv=FOUNDRY_CODEX_BIN=${native}`,
      `--setenv=HOME=${root}`,
      `--setenv=CODEX_HOME=${join(root, "codex-home")}`,
      `--setenv=PATH=${process.env.PATH}`,
      process.execPath,
      entry,
      "http://127.0.0.1:1",
    ]);
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
    second?.close();
    worker?.kill("SIGKILL");
    if (managed) {
      execFileSync("systemctl", ["--user", "stop", unit]);
    } else {
      try {
        process.kill(-host.pid, "SIGTERM");
      } catch {}
      await pause(350);
      try {
        process.kill(-host.pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => {
    if (host.exitCode !== null) throw new Error(stderr);
    return existsSync(join(hostRoot, "control.sock"));
  });
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
      `import {ExecutionHostClient} from ${JSON.stringify(clientURL)};const c=new ExecutionHostClient(${JSON.stringify(join(hostRoot, "control.sock"))},'test-auth');await c.open();await c.run(${JSON.stringify(workspace)},${JSON.stringify(payload)});process.send('ready');`,
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
  first = new ExecutionHostClient(join(hostRoot, "control.sock"), "test-auth");
  await assert.rejects(first.open(), /Another live worker/);
  first.close();
  worker.kill("SIGKILL");
  await once(worker, "exit");
  await pause(75);
  second = new ExecutionHostClient(join(hostRoot, "control.sock"), "test-auth");
  const received = [];
  const transport = new ReliableSessionTransport();
  transport.bind({
    readyState: 1,
    send: (data) => received.push(JSON.parse(data)),
  });
  const registry2 = new SessionExecutionRegistry();
  second.attach(transport, registry2);
  await second.open();
  assert.equal(second.owns("sess_host_test", "input-1"), true);
  await second.run(workspace, payload);
  assert.equal(readFileSync(count, "utf8"), "start\n");
  await second.steer("sess_host_test", "steer-1", "finish", []);
  await until(() => received.some((e) => e.type === "session_completed"));
  assert.equal(
    received.find((e) => e.type === "session_completed").payload.response,
    "survived",
  );
  assert.ok(received.some((e) => e.type === "session_started"));
  await second.refresh();
  assert.deepEqual(registry2.activeSessionIds(), []);
  if (managed) {
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
    execFileSync("systemctl", [
      "--user",
      "kill",
      "--kill-whom=main",
      "--signal=SIGKILL",
      unit,
    ]);
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
  const bad = new ExecutionHostClient(join(hostRoot, "control.sock"), "wrong");
  await assert.rejects(bad.open(), /authentication/);
  bad.close();
});
