import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerThread } from "../dist/runner/codex-app-server.js";
import { runCodexStreamedTurn } from "../dist/runner/codex-stream.js";
import {
  superviseAgentProcesses,
  processIdentity,
} from "../dist/agent-processes.js";

// Use a real OS writer lock and delayed shutdown, not a boolean in a generator.
// No provider requests are made. The test launcher isolates all runtime state.
const python = spawnSync("python3", ["-c", "import fcntl"], {
  encoding: "utf8",
});
const supported = process.platform === "linux" && python.status === 0;
if (supported) await superviseAgentProcesses();

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "codex-writer-"));
  const bin = join(root, "codex");
  const lock = join(root, "writer.lock");
  const pidFile = join(root, "pid");
  t.after(() => {
    for (const path of [pidFile, pidFile + ".child"]) {
      try {
        process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    `#!/usr/bin/env python3
import fcntl, json, os, signal, sys, time
mode = os.environ['WRITER_MODE']
lock = open(os.environ['WRITER_LOCK'], 'a+')
def stop(sig, frame):
    if mode == 'ignore-term': return
    time.sleep(0.2)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
def send(x): print(json.dumps(x), flush=True)
def notify(status): send({'method':'turn/completed', 'params':{'threadId':'native', 'turn':{'id':'turn-1','status':status,'error':{'message':'Selected model is at capacity'}}}})
for line in sys.stdin:
    r=json.loads(line)
    if 'id' not in r: continue
    method=r['method']
    if method == 'thread/backgroundTerminals/list' and mode == 'inventory-pending': continue
    result={}
    if method in ['thread/start','thread/resume']:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            send({'id':r['id'],'error':{'message':'thread native already has an active writer'}})
            continue
        with open(os.environ['WRITER_PID'],'w') as f: f.write(str(os.getpid()))
        if mode == 'orphan-writer':
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            pid = os.fork()
            if pid == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                for fd in [0,1,2]: os.close(fd)
                while True: time.sleep(1)
            signal.signal(signal.SIGTERM, stop)
            with open(os.environ['WRITER_PID']+'.child','w') as f: f.write(str(pid))
        result={'thread':{'id':'native'}}
        if mode == 'startup-failure':
            send({'id':r['id'],'error':{'message':'startup refused after locking'}})
            continue
    if method == 'turn/start': result={'turn':{'id':'turn-1'}}
    send({'id':r['id'],'result':result})
    if method == 'turn/start' and mode != 'quiet': notify('completed' if mode in ['success', 'inventory-pending'] else 'failed')
`,
    { mode: 0o700 },
  );
  const thread = new CodexAppServerThread(
    bin,
    {
      ...process.env,
      WRITER_MODE: mode,
      WRITER_LOCK: lock,
      WRITER_PID: pidFile,
      FOUNDRY_CODEX_AUTH_SOURCE: "",
    },
    {},
    {
      workingDirectory: root,
      ...(mode === "inventory-pending"
        ? { workSessionId: "inventory-pending" }
        : {}),
    },
    "native",
  );
  const state = {
    emit: async () => {},
    eventsPath: join(root, "events.jsonl"),
    files: { recordToolWrite: async () => {} },
    reportNativeSessionId: () => {},
    nativeSessionId: "native",
    thread: {},
    context: { follow: async () => {}, read: async () => [] },
  };
  const assertReleased = () => {
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(
      processIdentity(pid),
      undefined,
      "old writer is still running",
    );
    if (mode === "orphan-writer") {
      const child = Number(readFileSync(pidFile + ".child", "utf8"));
      assert.equal(
        processIdentity(child),
        undefined,
        "child still owns the writer after its parent exited",
      );
    }
    const probe = spawnSync("python3", [
      "-c",
      "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
      lock,
    ]);
    assert.equal(probe.status, 0, "native writer lock is still held");
  };
  return { thread, state, assertReleased };
}

for (const mode of [
  "failure",
  "success",
  "ignore-term",
  "orphan-writer",
  "inventory-pending",
]) {
  test(
    `Codex ${mode} waits for writer release before an immediate same-thread retry`,
    { skip: !supported, timeout: 20000 },
    async (t) => {
      const { thread, state, assertReleased } = fixture(t, mode);
      for (let attempt = 0; attempt < 2; attempt++) {
        const turn = runCodexStreamedTurn(
          state,
          thread,
          "test",
          `writer-${mode}`,
        );
        if (mode === "success" || mode === "inventory-pending") await turn;
        else await assert.rejects(turn, /Selected model is at capacity/);
        assertReleased();
      }
    },
  );
}

test(
  "startup failure releases the writer before returning",
  { skip: !supported },
  async (t) => {
    const { thread, assertReleased } = fixture(t, "startup-failure");
    await assert.rejects(
      thread.runStreamed("test"),
      /startup refused after locking/,
    );
    assertReleased();
  },
);

test(
  "cancellation waits for delayed native shutdown and releases the writer",
  { skip: !supported },
  async (t) => {
    const { thread, assertReleased } = fixture(t, "quiet");
    const controller = new AbortController();
    const { events } = await thread.runStreamed("test", {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(async () => {
      for await (const event of events) {
      }
    }, /interrupted/);
    assertReleased();
  },
);
