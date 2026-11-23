#!/usr/bin/env node
// Stand-in for the Claude Code CLI, used by scripts/ci-worker-restart.mjs.
// The Worker's Claude runtime (Agent SDK) launches it through FOUNDRY_CLAUDE_BIN
// and speaks stream-json to it. Only the model is faked: a turn writes its
// messages to a JSONL transcript where the real CLI keeps them (under
// CLAUDE_CONFIG_DIR, or ~/.claude), and an answer is read back from that
// transcript. The Worker checks for that transcript before it resumes a native
// session, and --resume must find it, so a resumed session really continues.
// FAKE_CLAUDE_HOLD=1 (scripts/pa-eval-run.mjs sets it in a wrapper): a turn
// records the message and never answers, as a helper still at work; the
// session runs until it is cancelled. A connection check's prompt is still
// answered.

const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "fixture",
    }),
  );
  process.exit(0);
}

// The Agent SDK passes --flag=value; the CLI also takes --flag value.
const flagValue = (flag) => {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const resumed = flagValue("--resume");
const sessionId = resumed ?? flagValue("--session-id") ?? randomUUID();
const persists = !args.includes("--no-session-persistence");
const configDir =
  process.env.CLAUDE_CONFIG_DIR?.trim() ||
  join(process.env.HOME || homedir(), ".claude");
const projectDir = join(
  configDir,
  "projects",
  process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
);
const transcript = join(projectDir, `${sessionId}.jsonl`);

const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let started = false;
let turns = 0;

function history() {
  if (!existsSync(transcript)) return [];
  return readFileSync(transcript, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function append(entry) {
  if (!persists) return;
  mkdirSync(projectDir, { recursive: true });
  appendFileSync(
    transcript,
    JSON.stringify({
      ...entry,
      sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
}

function entryText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

function reply(text, ok = true) {
  turns += 1;
  append({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  out({
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    message: {
      id: `msg_${turns}`,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  out({
    type: "result",
    subtype: ok ? "success" : "error_during_execution",
    is_error: !ok,
    result: text,
    errors: ok ? [] : [text],
    session_id: sessionId,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
  });
}

function initialize() {
  started = true;
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "fixture",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    output_style: "default",
    uuid: randomUUID(),
  });
}

function answerFrom(past, text) {
  if (/which codeword/i.test(text)) {
    for (const entry of [...past].reverse()) {
      const remembered = /codeword ([A-Za-z]+-\d+)/i.exec(entryText(entry));
      if (remembered && !/which codeword/i.test(entryText(entry)))
        return { text: remembered[1] };
    }
    return { text: "UNKNOWN" };
  }
  const busy = /sleep (\d+)/.exec(text);
  if (busy) return { text: "DONE", delaySeconds: Number(busy[1]) };
  return { text: "OK" };
}

function turn(text) {
  const past = history();
  append({ type: "user", message: { role: "user", content: text } });
  // A held helper is still at work; a connection check is answered.
  if (
    process.env.FAKE_CLAUDE_HOLD === "1" &&
    text.trim() !== "Reply with the single word OK."
  )
    return;
  const { text: answer, delaySeconds } = answerFrom(past, text);
  if (delaySeconds === undefined) reply(answer);
  else setTimeout(() => reply(answer), delaySeconds * 1000);
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {},
        },
      });
      return;
    }
    if (message.type !== "user") return;
    if (!started) initialize();
    if (resumed && !existsSync(transcript)) {
      reply(`No conversation found with session ID: ${sessionId}`, false);
      return;
    }
    turn(entryText(message));
  })
  .on("close", () => process.exit(0));
