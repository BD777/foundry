#!/usr/bin/env node
// Live web regression: drives the Foundry web app in a real browser
// (agent-browser) against a running stack with real agents, for the chat
// behaviours only a page shows. Cases: docs/live-regression.md (C7–C9).
//
//   FOUNDRY_WEB_URL=http://127.0.0.1:42983 FOUNDRY_WEB_USERNAME=tester \
//   FOUNDRY_WEB_PASSWORD=… node scripts/live-web-regression.mjs \
//     --workspace <id> [--codex] [--cases conversation,queued-steer]
//
// Expected answers never appear in the prompts: they are computed and tagged
// ANSWER-<n>, so a match can only come from the agent, never from a prompt or
// an id elsewhere on the page.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    codex: { type: "boolean" },
    cases: { type: "string" },
  },
});
const base = process.env.FOUNDRY_WEB_URL;
const username = process.env.FOUNDRY_WEB_USERNAME;
const password = process.env.FOUNDRY_WEB_PASSWORD;
if (!base || !username || !password || !values.workspace) {
  console.error(
    "usage: FOUNDRY_WEB_URL=… FOUNDRY_WEB_USERNAME=… FOUNDRY_WEB_PASSWORD=… live-web-regression.mjs --workspace <id> [--codex] [--cases a,b]",
  );
  process.exit(2);
}

const browser = (...args) =>
  execFileSync("agent-browser", args, { encoding: "utf8" }).trim();
// agent-browser prints an evaluated value as JSON.
const page = (expression) => JSON.parse(browser("eval", expression) || "null");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Text of the rendered messages, without the chat list or composer. */
function transcriptText() {
  return page(`document.querySelector(".fdy-chat-messages")?.innerText ?? ""`);
}

async function waitForText(text, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (transcriptText().includes(text)) return;
    await sleep(2000);
  }
  throw new Error(`"${text}" never appeared`);
}

function click(role, name) {
  browser("find", "role", role, "click", "--name", name);
}

async function send(text) {
  browser("find", "role", "textbox", "fill", text, "--name", "Chat input");
  browser("press", "Enter");
  await sleep(1500);
}

function signIn() {
  browser("open", `${base}/chats?workspace=${values.workspace}`);
  browser("wait", "3000");
  if (browser("snapshot").includes('heading "Sign in to Foundry"')) {
    browser("find", "role", "textbox", "fill", username, "--name", "Username");
    browser("find", "role", "textbox", "fill", password, "--name", "Password");
    click("button", "Sign in");
    browser("wait", "3000");
    browser("open", `${base}/chats?workspace=${values.workspace}`);
    browser("wait", "3000");
  }
}

/** Picks the composer's agent; the choice persists across chats. */
async function useAgent(name) {
  click("button", "Chat agent:");
  await sleep(800);
  click("menuitemradio", name);
  await sleep(800);
}

async function newChat() {
  click("button", "New chat");
  await sleep(1000);
  await useAgent("Claude");
}

let conversationUrl = "";

const cases = {
  // C7: one chat holds both exchanges and both answers; the turn directory
  // counts every input.
  async conversation() {
    await newChat();
    await send(
      "Remember the number 17. What is 17 plus 25? Reply with exactly ANSWER- followed by the number.",
    );
    await waitForText("ANSWER-42");
    conversationUrl = browser("get", "url");
    await send(
      "Multiply the number I asked you to remember by 3. Reply with exactly ANSWER- followed by the result.",
    );
    await waitForText("ANSWER-51");
    check(
      browser("get", "url") === conversationUrl,
      "the follow-up opened another chat",
    );
    browser("open", conversationUrl);
    browser("wait", "4000");
    const text = transcriptText();
    check(
      text.includes("ANSWER-42") && text.includes("ANSWER-51"),
      "after reload, both answers are not shown",
    );
    const directory = page(
      `(document.body.innerText.match(/会话目录\\s*(\\d+)\\s*\\/\\s*(\\d+)/) ?? []).slice(1)`,
    );
    check(
      directory.length === 0 || directory[1] === "2",
      `the turn directory counts ${directory[1]} inputs`,
    );
    return `one chat with ANSWER-42 then ANSWER-51`;
  },

  // C8: a message typed while the agent works is queued; steering it reaches
  // the active response.
  async "queued-steer"() {
    await newChat();
    await send(
      "Use Bash to run: sleep 30. Then reply DONE, followed by the result of any extra instruction I send meanwhile.",
    );
    await sleep(8000);
    await send(
      "Extra instruction: compute 6 times 9 and include it as ANSWER- followed by the product.",
    );
    check(
      browser("snapshot").includes(
        "Steer this message into the active response",
      ),
      "the message typed during the response was not queued",
    );
    click("button", "Steer this message into the active response");
    await waitForText("ANSWER-54");
    return "the queued message was steered; the answer includes ANSWER-54";
  },

  // C9: switching the chat's agent continues the same chat on another runtime
  // with the conversation imported.
  async "agent-switch"() {
    check(conversationUrl, "runs after the conversation case");
    browser("open", conversationUrl);
    browser("wait", "4000");
    await useAgent("Codex");
    await send(
      "Add 100 to the first number you computed in this chat. Reply with exactly ANSWER- followed by the result.",
    );
    await waitForText("ANSWER-142");
    check(
      transcriptText().includes("切换为"),
      "no profile transition boundary is shown",
    );
    browser("open", conversationUrl);
    browser("wait", "4000");
    const text = transcriptText();
    check(
      ["ANSWER-42", "ANSWER-51", "ANSWER-142"].every((answer) =>
        text.includes(answer),
      ),
      "after reload, an earlier answer was replaced by a later one",
    );
    check(
      browser("get", "url") === conversationUrl,
      "the switch opened another chat",
    );
    return "the same chat continued on Codex with ANSWER-142";
  },
};

const selected = values.cases
  ? values.cases.split(",").map((name) => name.trim())
  : ["conversation", "queued-steer", ...(values.codex ? ["agent-switch"] : [])];
signIn();
let failed = 0;
for (const name of selected) {
  const started = Date.now();
  try {
    const evidence = await cases[name]();
    console.log(
      `✔ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${evidence}`,
    );
  } catch (error) {
    failed++;
    console.log(
      `✖ ${name} (${Math.round((Date.now() - started) / 1000)}s): ${error instanceof Error ? error.message : error}`,
    );
  }
}
process.exit(failed ? 1 : 0);
