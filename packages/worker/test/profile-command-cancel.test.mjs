import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProfileCommandSession } from "../dist/runner/profile-command.js";
import { superviseAgentProcesses } from "../dist/agent-processes.js";
import { cancelActiveSession } from "../dist/session-control.js";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
test(
  "custom command cancellation waits for its owned process to exit",
  { timeout: 15000 },
  async (t) => {
    await superviseAgentProcesses();
    const root = mkdtempSync(join(tmpdir(), "profile-cancel-"));
    const sessionDir = join(root, "session");
    mkdirSync(sessionDir);
    const counter = join(root, "counter");
    const script = join(root, "count.mjs");
    writeFileSync(
      script,
      'import{writeFileSync}from"node:fs";let n=0;setInterval(()=>writeFileSync(process.argv[2],String(++n)),25);',
    );
    const session = {
      id: "synthetic-command-cancel",
      threadId: "synthetic-command-cancel",
      workspaceId: "w",
      agentId: "a",
      deviceId: "d",
      provider: "codex",
      source: "chat",
      status: "running",
      title: "Synthetic command",
      prompt: "Synthetic local process",
      input: {
        id: "exact-input",
        prompt: "Synthetic local process",
        executionBudget: {
          snapshotId: "synthetic",
          tokenBudget: 1000,
          timeoutMinutes: 1,
        },
      },
      createdLabel: "",
      updatedLabel: "",
    };
    const run = runProfileCommandSession(
      root,
      session,
      sessionDir,
      {
        id: "synthetic-command",
        runtime: "codex",
        connectionType: "custom_command",
        command: `${quote(process.execPath)} ${quote(script)} ${quote(counter)}`,
      },
      async () => {},
    );
    const outcome = run.then(
      () => ({}),
      (error) => ({ error }),
    );
    t.after(async () => {
      await cancelActiveSession(session.id, session.input.id);
      await outcome;
      rmSync(root, { recursive: true, force: true });
    });
    const end = Date.now() + 5000;
    while (!existsSync(counter) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(counter));
    await cancelActiveSession(session.id, "old-input");
    const before = readFileSync(counter, "utf8");
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(
      readFileSync(counter, "utf8"),
      before,
      "old input cancelled the current command",
    );
    const request = await cancelActiveSession(session.id, session.input.id);
    assert.equal(request.stopped, undefined, "request is not an exit receipt");
    const result = await outcome;
    assert.equal(result.error?.name, "AgentSessionCanceledError");
    const stopped = readFileSync(counter, "utf8");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      readFileSync(counter, "utf8"),
      stopped,
      "a child process outlived the completed cancellation",
    );
  },
);
