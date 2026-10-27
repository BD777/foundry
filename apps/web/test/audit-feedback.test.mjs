import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("feedback audit rejects new ad-hoc hints, hand-built menus and action-result Alerts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "foundry-feedback-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src/features"), { recursive: true });
  const fixture = join(directory, "src/features/fixture.tsx");
  const audit = fileURLToPath(
    new URL("../scripts/audit-feedback.mjs", import.meta.url),
  );
  const run = (source) => {
    writeFileSync(fixture, source);
    return spawnSync(process.execPath, [audit], {
      cwd: directory,
      encoding: "utf8",
    });
  };
  for (const [source, reason] of [
    ['<p className="fdy-new-field-hint">Help</p>', /FieldHint or Alert/],
    [
      "<ContextMenu.Item asChild><Button>Archive</Button></ContextMenu.Item>",
      /shared row-menu/,
    ],
    ['<Alert title={t("form.saveFailed")} />', /must use Toast/],
  ]) {
    const result = run(source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, reason);
  }
  assert.equal(
    run(
      '<FieldHint>Help</FieldHint><Alert title={t("page.loadFailed")} /><ContextMenuEntry>Archive</ContextMenuEntry>',
    ).status,
    0,
  );
});
