import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { subagentResponseFingerprint } from "../dist/index.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./subagent-response-fixtures.json", import.meta.url),
    "utf8",
  ),
);

test("fingerprints a subagent answer as its fixture says", () => {
  for (const { text, fingerprint } of fixtures) {
    assert.equal(
      subagentResponseFingerprint(text),
      fingerprint,
      JSON.stringify(text),
    );
  }
});

test("matches FNV-1a 64 over the trimmed UTF-8 for long and varied text", () => {
  const reference = (text) => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text.trim()))
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    return hash.toString(16).padStart(16, "0");
  };
  let text = "";
  for (let index = 0; index < 4000; index += 1)
    text += String.fromCodePoint(
      (index * 7919) % 0x2fff,
      0x20,
      0x1f600 + (index % 50),
    );
  for (const sample of [text, ` ${text}\n`, text.slice(0, 1), "ÿ".repeat(300)])
    assert.equal(subagentResponseFingerprint(sample), reference(sample));
});
