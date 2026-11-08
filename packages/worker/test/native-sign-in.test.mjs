// The official subscriptions' sign-in on the device
// (harness/native/native-sign-in.ts, native_sign_in): Claude Code's
// claude.ai sign-in (a page, then the pasted code) and Codex's device code,
// run by the CLI on the device; the login then reads as the device's local
// profiles read it. Fake CLIs stand in for claude and codex; nothing
// reaches a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fdy-native-sub-"));
const state = join(root, "state.json");
const calls = join(root, "calls.jsonl");
writeFileSync(state, JSON.stringify({ claude: false, codex: false }));
const fake = (name, body) => {
  const path = join(root, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
// Status reads run fakes concurrently: replace the file whole, never half-written.
const save = () => { const tmp = ${JSON.stringify(state)} + "." + process.pid; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, ${JSON.stringify(state)}); };
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ name: ${JSON.stringify(name)}, args, browser: process.env.BROWSER, key: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n");
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
};
const claude = fake(
  "claude",
  `if (args[0] === "--version") { console.log("2.1.295 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") {
  console.log(JSON.stringify(state.claude ? { loggedIn: true, authMethod: "claude.ai", email: "me@example.com" } : { loggedIn: false }));
  process.exit(state.claude ? 0 : 1);
}
if (args.join(" ") === "auth login --claudeai") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=secret-state");
  process.stdout.write("Paste code here if prompted > ");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\\n")) return;
    if (!input.trim().includes("#")) { console.log("Invalid code. Please make sure the full code was copied."); input = ""; return; }
    if (input.trim() !== "good-code#secret-state") { console.log("Login failed: Request failed with status code 403"); process.exit(1); }
    state.claude = true; save(); console.log("Login successful."); process.exit(0);
  });
} else if (args.join(" ") === "auth logout") { state.claude = false; save(); console.log("Successfully logged out"); process.exit(0); }
else process.exit(9);`,
);
const codex = fake(
  "codex",
  `if (args[0] === "--version") { console.log("codex-cli 0.163.0"); process.exit(0); }
if (args.join(" ") === "login status") {
  console.log(state.codex ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(state.codex ? 0 : 1);
}
if (args.join(" ") === "login --device-auth") {
  console.log("\\u001b[90mFollow these steps\\u001b[0m\\n1. Open this link in your browser and sign in to your account\\n   \\u001b[94mhttps://auth.openai.com/codex/device\\u001b[0m\\n\\n2. Enter this one-time code \\u001b[90m(expires in 15 minutes)\\u001b[0m\\n   \\u001b[94mABCD-12345\\u001b[0m\\n");
  if (state.codexFail) setTimeout(() => { console.error("Error: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/token)"); process.exit(1); }, 300);
  else setTimeout(() => { state.codex = true; save(); process.exit(0); }, 300);
} else if (args[0] === "logout") { state.codex = false; save(); process.exit(0); }
else process.exit(9);`,
);
process.env.FOUNDRY_CLAUDE_BIN = claude;
process.env.FOUNDRY_CODEX_BIN = codex;
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
process.env.CODEX_HOME = join(root, "codex-home");
process.env.ANTHROPIC_API_KEY = "must-not-reach-the-login";

const {
  nativeSignIn,
  parseClaudeLoginPage,
  parseCodexDeviceCode,
  reapNativeSignIns,
} = await import("../dist/harness/native/native-sign-in.js");
const { readNativeLoginHealth, nativeLoginRevision } =
  await import("../dist/harness/native/native-login.js");
const { foundryStatePath } = await import("../dist/platform/state-root.js");

const op = (n) => `operation-${n}-${"x".repeat(20)}`;
const step = (runtime, action, operationId, input) =>
  nativeSignIn({ runtime, action, operationId, input });
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const settled = (runtime, operationId) =>
  until(async () => {
    const next = await step(runtime, "poll", operationId);
    return next.status !== "pending" && next;
  }, `the ${runtime} sign-in to end`);
const lastCall = (name, first) =>
  readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((c) => c.name === name && c.args[0] === first)
    .at(-1);

test("the CLIs' sign-in pages are read through their colours, and nothing else is taken for one", () => {
  assert.equal(
    parseClaudeLoginPage(
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\nPaste code here if prompted > ",
    ),
    "https://claude.com/cai/oauth/authorize?code=true&state=s",
  );
  assert.equal(parseClaudeLoginPage("Opening browser to sign in…"), undefined);
  assert.deepEqual(
    parseCodexDeviceCode(
      "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mWXYZ-9876\u001b[0m\n",
    ),
    { url: "https://auth.openai.com/codex/device", code: "WXYZ-9876" },
  );
  assert.equal(
    parseCodexDeviceCode("https://auth.openai.com/codex/device"),
    undefined,
  );
});

test("Claude: the device shows Claude's page, takes the pasted code, and the login reads as the profiles read it", async () => {
  assert.equal(readNativeLoginHealth("claude").status, "missing_auth");

  // A code without its state: Claude Code asks again; the sign-in ends with its words.
  let begin = await step("claude", "begin", op(1));
  assert.equal(begin.status, "pending");
  assert.equal(begin.operationId, op(1));
  assert.equal(begin.codeEntry, true);
  assert.match(
    begin.verificationUrl,
    /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/,
  );
  // A poll while it waits repeats the page, so the code field stays.
  const waiting = await step("claude", "poll", op(1));
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.codeEntry, true);
  assert.equal(waiting.verificationUrl, begin.verificationUrl);
  const login = lastCall("claude", "auth");
  assert.equal(login.browser, "true", "no browser opens on the device");
  assert.equal(
    login.key,
    "",
    "an API key in the worker never reaches the login",
  );
  await step("claude", "input", op(1), "half-a-code");
  assert.deepEqual(await settled("claude", op(1)), {
    status: "failed",
    operationId: op(1),
    error: "Invalid code. Please make sure the full code was copied.",
  });

  // A wrong code: Claude Code's own words, never its page or state.
  await step("claude", "begin", op(2));
  await step("claude", "input", op(2), "bad-code#secret-state");
  const failed = await settled("claude", op(2));
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.error,
    "Login failed: Request failed with status code 403",
  );

  // A step naming another sign-in is told it expired.
  await step("claude", "begin", op(3));
  assert.equal((await step("claude", "poll", op(2))).status, "expired");
  const revision = nativeLoginRevision();
  await step("claude", "input", op(3), "  good-code#secret-state\n");
  assert.equal((await settled("claude", op(3))).status, "complete");
  assert.ok(nativeLoginRevision() > revision, "the device reports again");
  const health = readNativeLoginHealth("claude");
  assert.equal(health.status, "healthy");
  assert.equal(health.accountLabel, "me@example.com");

  assert.equal(await step("claude", "sign_out"), undefined);
  assert.equal(readNativeLoginHealth("claude").status, "missing_auth");
});

test("Codex: the device shows the OpenAI page and one-time code, and signs in when approved", async () => {
  const begin = await step("codex", "begin", op(4));
  assert.deepEqual(
    {
      status: begin.status,
      url: begin.verificationUrl,
      code: begin.userCode,
      codeEntry: begin.codeEntry,
    },
    {
      status: "pending",
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-12345",
      codeEntry: undefined,
    },
  );
  assert.equal((await settled("codex", op(4))).status, "complete");
  // The answer may have been lost: asking again a moment later says the same.
  assert.equal((await step("codex", "poll", op(4))).status, "complete");
  assert.equal(readNativeLoginHealth("codex").status, "healthy");
  await step("codex", "sign_out");
  assert.equal(readNativeLoginHealth("codex").status, "missing_auth");
  assert.deepEqual(lastCall("codex", "logout").args, ["logout"]);
});

test("a dismissed sign-in ends its CLI; one a previous worker left running is ended when the next starts", async () => {
  const pidOf = () =>
    JSON.parse(readFileSync(foundryStatePath("native-sign-ins.json"), "utf8"))
      .claude;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await step("claude", "begin", op(5));
  const dismissed = pidOf();
  assert.equal((await step("claude", "dismiss", op(5))).status, "expired");
  await until(() => !alive(dismissed), "the dismissed sign-in to end");

  await step("claude", "begin", op(6));
  const left = pidOf();
  assert.ok(left > 1 && alive(left));
  reapNativeSignIns();
  await until(() => !alive(left), "the left sign-in to end");
  assert.deepEqual(
    JSON.parse(readFileSync(foundryStatePath("native-sign-ins.json"), "utf8")),
    {},
  );
  await step("claude", "dismiss", op(6));
});

test("a step needs a runtime it knows and an operation id", async () => {
  await assert.rejects(step("mock", "begin", op(7)), /Unknown runtime/);
  await assert.rejects(step("claude", "begin", "short"), /operation id/);
});

test('a Codex sign-in that fails after showing its code says why, never "expired" or the code', async () => {
  writeFileSync(
    state,
    JSON.stringify({
      ...JSON.parse(readFileSync(state, "utf8")),
      codexFail: true,
    }),
  );
  try {
    const begin = await step("codex", "begin", op(7));
    assert.equal(begin.status, "pending");
    const ended = await settled("codex", op(7));
    assert.equal(ended.status, "failed");
    assert.match(ended.error, /error sending request/);
    assert.doesNotMatch(ended.error, /ABCD-12345|expires in/);
  } finally {
    const current = JSON.parse(readFileSync(state, "utf8"));
    delete current.codexFail;
    writeFileSync(state, JSON.stringify(current));
  }
});

test("a sign-in replaced while it waits for its page answers expired and leaves the new one running", async () => {
  const first = step("claude", "begin", op(8));
  // Replaced before the CLI could show its page.
  const second = await step("claude", "begin", op(9));
  assert.equal(second.status, "pending");
  assert.equal((await first).status, "expired");
  assert.equal((await step("claude", "poll", op(9))).status, "pending");
  await step("claude", "dismiss", op(9));
});
