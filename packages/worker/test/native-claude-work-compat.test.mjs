/** Opt-in real installed CLI test with a deterministic local protocol fixture.
 * The SDK/CLI makes every model-protocol request; no provider credentials/inference. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "../dist/session-state.js";

test(
  "real Claude SDK stops exactly one native background task and emits its terminal receipt",
  { skip: process.env.RUN_NATIVE_WORK_COMPAT !== "1", timeout: 60000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "dev022-claude-"));
    let requested = false;
    const fixture = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (!req.url?.includes("messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const tool = (id) => ({
        type: "tool_use",
        id,
        name: "Bash",
        input: {
          command: "sleep 45",
          run_in_background: true,
          description: `DEV022 background ${id}`,
        },
      });
      const content = requested
        ? [{ type: "text", text: "Both commands have started." }]
        : [tool("tool-a"), tool("tool-b")];
      requested = true;
      const msg = {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: { ...msg, content: [], stop_reason: null },
      });
      content.forEach((block, index) => {
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block:
            block.type === "tool_use"
              ? { ...block, input: {} }
              : { type: "text", text: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta:
            block.type === "tool_use"
              ? {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                }
              : { type: "text_delta", text: block.text },
        });
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: msg.stop_reason, stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    const input = new AsyncInputQueue();
    const messages = [];
    const run = query({
      prompt: input,
      options: {
        cwd: root,
        pathToClaudeCodeExecutable:
          process.env.WORK_COMPAT_CLAUDE || "/home/windeng/.local/bin/claude",
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model: "claude-sonnet-4-6",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, "config"),
          ANTHROPIC_API_KEY: "synthetic-protocol-fixture",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${fixture.address().port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });
    const pump = (async () => {
      for await (const message of run) messages.push(message);
    })();
    const wait = async (predicate) => {
      const until = Date.now() + 25000;
      while (!predicate() && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        predicate(),
        `missing native evidence: ${messages
          .filter((x) => x.type === "system")
          .map((x) => x.subtype)
          .join(",")}`,
      );
    };
    try {
      input.push({
        type: "user",
        message: {
          role: "user",
          content: "Run the two test background commands.",
        },
        parent_tool_use_id: null,
      });
      await wait(
        () => messages.filter((x) => x.subtype === "task_started").length >= 2,
      );
      const started = messages.filter((x) => x.subtype === "task_started");
      const [first, second] = started;
      await run.stopTask(first.task_id);
      await wait(() =>
        messages.some(
          (x) =>
            x.subtype === "task_notification" &&
            x.task_id === first.task_id &&
            x.status === "stopped",
        ),
      );
      assert.equal(
        messages.some(
          (x) =>
            x.subtype === "task_notification" && x.task_id === second.task_id,
        ),
        false,
        "sibling task was stopped",
      );
    } finally {
      run.close();
      input.close();
      await pump.catch(() => {});
      await new Promise((r) => fixture.close(r));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
