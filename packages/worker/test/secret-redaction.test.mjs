import assert from "node:assert/strict";
import test from "node:test";
import {
  redactSecrets,
  redactTranscriptText,
} from "../dist/platform/secret-redaction.js";
import { redactLogLine } from "../dist/daemon/diagnostics.js";
import { maskCommand } from "../dist/harness/profiles.js";

// Synthetic values; provider-format ones are joined at runtime.
const github = ["gh", "p_R4nd0mT0k3nV4lu3F0rT3st1ngPurp0s3s12"].join("");
const jwt = ["ey", "JhbGciOiJIUzI1NiJ9.c3ViamVjdA1234.c2lnbmF0dXJl"].join("");

test("operational text and log lines share one rule set", () => {
  const samples = [
    ["postgres://app:hunter2pw@db.internal/app", "hunter2pw"],
    ["https://alice:s3cret-pw@relay.example/v1", "s3cret-pw"],
    ["GET /callback?code=oauth-code-123&state=x", "oauth-code-123"],
    ['{"token": "abcd1234efgh"}', "abcd1234efgh"],
    ["credential=dev-cred-0001", "dev-cred-0001"],
    ["using fdy_abcdefgh12345 now", "fdy_abcdefgh12345"],
    ["key sk-shortish123 here", "sk-shortish123"],
    [`token ${jwt}`, jwt],
    [`push with ${github}`, github],
    ["Authorization: Bearer abc.def", "abc.def"],
    ["foundry provider save --api-key abcd1234efgh", "abcd1234efgh"],
  ];
  for (const [text, secret] of samples) {
    assert.equal(redactSecrets(text).includes(secret), false, text);
    assert.equal(redactLogLine(text).includes(secret), false, text);
  }
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
  assert.equal(
    redactLogLine("mail dev@example.com about relay.example"),
    "mail [email] about relay.example",
  );
});

test("transcripts keep short and placeholder values readable", () => {
  for (const text of [
    "token: abc",
    "set PASSWORD=$DB_PASSWORD",
    "call it with Bearer <token>",
  ])
    assert.equal(redactTranscriptText(text), text);
  assert.equal(redactTranscriptText(`see ${github}`), "see [REDACTED]");
});

test("a profile's command label does not show its credentials", () => {
  const label = maskCommand(
    "env ANTHROPIC_API_KEY=sk-synthetic-0123456789abcdef claude --print",
  );
  assert.equal(label.includes("sk-synthetic-0123456789abcdef"), false);
  assert.match(label, /^env ANTHROPIC_API_KEY=\[REDACTED\] claude --print$/);
});
