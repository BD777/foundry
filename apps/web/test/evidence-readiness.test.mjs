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
  const copy = readFileSync(
    new URL("../src/i18n/locales/en/issues.ts", import.meta.url),
    "utf8",
  );
  assert.match(meta, /issue\.contractState !== "confirmed"/);
  assert.match(meta, /issues:readiness\.awaitingContract/);
  assert.match(copy, /awaitingContract: "Awaiting contract confirmation"/);
  assert.match(card, /issueReadinessMeta\(issue\)/);
  assert.match(creation, /setFeedback\(t\("notices\.created"\)\)/);
  assert.match(
    copy,
    /created: "Issue created · awaiting contract confirmation"/,
  );
  assert.doesNotMatch(copy, /ready for execution/);
});
