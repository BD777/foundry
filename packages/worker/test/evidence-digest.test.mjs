import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { digestObject } from "../dist/material/evidence-store.js";

// The same canonical texts the server's evidenceDigest is tested against
// (apps/server/internal/sqlitestore/evidence_digest_test.go).
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../protocol/test/evidence-digest-fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const [index, fixture] of fixtures.entries())
  test(`content digest matches the server's canonical JSON (${index})`, () =>
    assert.equal(
      digestObject(fixture.value),
      `sha256:${createHash("sha256").update(fixture.canonical).digest("hex")}`,
    ));
