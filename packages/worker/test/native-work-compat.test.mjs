/** Opt-in compatibility check against the installed, real Claude CLI. The local
 * deterministic protocol fixture is not a real model or a provider credential. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "../dist/session-state.js";

test(
  "real native CLI disables restored cron and restores work context across compaction",
  { skip: process.env.RUN_NATIVE_WORK_COMPAT !== "1", timeout: 150000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "native-work-compat-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const requests = [];
    const fixture = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (!req.url?.includes("messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const message = {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "ACK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      };
      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [event, data] of [
        [
          "message_start",
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null },
          },
        ],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ACK" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ])
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    t.after(() => fixture.close());
    const url = `http://127.0.0.1:${fixture.address().port}`;
    const sessions = [];
    async function start(disabled) {
      const dir = join(root, disabled ? "disabled" : "baseline"),
        id = randomUUID();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/scheduled_tasks.json"),
        JSON.stringify({
          tasks: [
            {
              id: "00000001",
              cron: "* * * * *",
              prompt: `NATIVE_WORK_TIMER_${disabled ? "DISABLED" : "BASELINE"}`,
              createdAt: Date.now(),
              lastFiredAt: Date.now(),
              recurring: true,
              createdBySessionId: id,
              createdInProject: dir,
            },
          ],
        }),
      );
      const input = new AsyncInputQueue();
      let results = 0,
        compactions = 0,
        errors = "";
      const run = query({
        prompt: input,
        options: {
          cwd: dir,
          sessionId: id,
          pathToClaudeCodeExecutable:
            process.env.WORK_COMPAT_CLAUDE ||
            `${process.env.HOME}/.local/bin/claude`,
          settingSources: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          model: "claude-sonnet-4-6",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: dir,
            CLAUDE_CONFIG_DIR: join(dir, "config"),
            ANTHROPIC_API_KEY: "synthetic-protocol-fixture",
            ANTHROPIC_BASE_URL: url,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_CRON: disabled ? "1" : "",
          },
          stderr: (s) => {
            errors += s;
          },
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  async () => ({
                    hookSpecificOutput: {
                      hookEventName: "UserPromptSubmit",
                      additionalContext:
                        "FOUND_PERSISTENT_WORK old_cron; desired=paused; use list_session_work",
                    },
                  }),
                ],
              },
            ],
            PostCompact: [
              {
                hooks: [
                  async () => {
                    compactions++;
                    input.push({
                      type: "user",
                      message: {
                        role: "user",
                        content:
                          "AFTER_COMPACT_PERSISTENT_WORK old_cron desired=paused",
                      },
                      parent_tool_use_id: null,
                      isSynthetic: true,
                      shouldQuery: false,
                    });
                    return undefined;
                  },
                ],
              },
            ],
          },
        },
      });
      const done = (async () => {
        for await (const message of run) {
          if (message.type === "result") results++;
        }
      })();
      sessions.push({ run, done, input });
      input.push({
        type: "user",
        message: {
          role: "user",
          content: `${disabled ? "DISABLED_SESSION" : "BASELINE_SESSION"}: reply ACK. Context: ${"deterministic acceptance history. ".repeat(1000)}`,
        },
        parent_tool_use_id: null,
      });
      const deadline = Date.now() + 25000;
      while (!results && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        results,
        `native initialization failed: ${errors.slice(-1800)}`,
      );
      return {
        input,
        get results() {
          return results;
        },
        get compactions() {
          return compactions;
        },
        errors: () => errors,
      };
    }
    try {
      const disabled = await start(true),
        baseline = await start(false);
      for (let n = 0; n < 3; n++) {
        const before = disabled.results;
        disabled.input.push({
          type: "user",
          message: {
            role: "user",
            content: "/compact preserve ongoing work identities",
          },
          parent_tool_use_id: null,
        });
        const deadline = Date.now() + 20000;
        while (disabled.compactions <= n && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 100));
        assert.ok(
          disabled.compactions > n,
          `native compact ${n + 1} did not complete: ${disabled.errors().slice(-1200)}`,
        );
        disabled.input.push({
          type: "user",
          message: { role: "user", content: `VERIFY_COMPACT_${n}: reply ACK` },
          parent_tool_use_id: null,
        });
        const until = Date.now() + 10000;
        while (disabled.results <= before && Date.now() < until)
          await new Promise((r) => setTimeout(r, 50));
      }
      const deadline = Date.now() + 70000;
      while (
        !requests.some((r) =>
          JSON.stringify(r.messages).includes("NATIVE_WORK_TIMER_BASELINE"),
        ) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 250));
      assert.ok(
        requests.some((r) =>
          JSON.stringify(r.messages).includes("NATIVE_WORK_TIMER_BASELINE"),
        ),
        "baseline native scheduler did not fire; test cannot prove disabled behavior",
      );
      assert.ok(
        !requests.some((r) =>
          JSON.stringify(r.messages).includes("NATIVE_WORK_TIMER_DISABLED"),
        ),
        "disabled native cron fired",
      );
      assert.ok(
        requests.filter((r) =>
          JSON.stringify(r.messages).includes("AFTER_COMPACT_PERSISTENT_WORK"),
        ).length >= 3,
        "persistent work context was not delivered after all compactions",
      );
    } finally {
      for (const s of sessions) {
        s.input.close();
        s.run.close();
      }
      await Promise.allSettled(sessions.map((s) => s.done));
    }
  },
);
