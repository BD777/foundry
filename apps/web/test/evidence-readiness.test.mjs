import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("unconfirmed issue cards and creation feedback never claim execution readiness", () => {
  const meta = readFileSync(
    new URL("../src/lib/issue-meta.ts", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("../src/features/issues/issue-board-card.tsx", import.meta.url),
    "utf8",
  );
  const creation = readFileSync(
    new URL("../src/features/issues/issues-feature.tsx", import.meta.url),
    "utf8",
  );
  assert.match(meta, /issue\.contractState !== "confirmed"/);
  assert.match(meta, /Awaiting contract confirmation/);
  assert.match(card, /issueReadinessMeta\(issue\)/);
  assert.match(creation, /Issue created · awaiting contract confirmation/);
  assert.doesNotMatch(creation, /Issue created · ready for execution/);
});
