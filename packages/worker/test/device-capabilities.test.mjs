import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installedBrowsers,
  sessionDeviceNotes,
} from "../dist/device-capabilities.js";

test("browsers on PATH are found once per executable", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "foundry-browsers-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const chromium = join(bin, "chromium");
  writeFileSync(chromium, "#!/bin/sh\n");
  chmodSync(chromium, 0o755);
  // Distributions often alias one browser under several names.
  symlinkSync(chromium, join(bin, "chromium-browser"));
  const found = installedBrowsers("linux", { PATH: bin });
  const onPath = found.filter((browser) => browser.path.startsWith(bin));
  assert.deepEqual(onPath, [{ name: "Chromium", path: chromium }]);
  assert.deepEqual(
    installedBrowsers("linux", { PATH: join(bin, "missing") }).filter(
      (browser) => browser.path.startsWith(bin),
    ),
    [],
  );
});

test("device notes name the installed browsers and where images must go", () => {
  const notes = sessionDeviceNotes("/work/space", [
    { name: "Google Chrome", path: "/opt/google/chrome/chrome" },
  ]);
  assert.match(notes, /Google Chrome \(\/opt\/google\/chrome\/chrome\)/);
  assert.match(notes, /do not download or install/);
  assert.match(notes, /--user-data-dir/);
  assert.match(notes, /\/work\/space\/\.foundry\/attachments\//);
  assert.match(notes, /<image path=/);
  assert.match(sessionDeviceNotes("/w", []), /No browser was found/);
});
