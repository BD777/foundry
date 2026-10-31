import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrograms } from "../dist/skill-requirements.js";

test("programs are checked on PATH; invalid names are not answered", () => {
  const bin = mkdtempSync(join(tmpdir(), "skill-bin-"));
  writeFileSync(join(bin, "present-tool"), "#!/bin/sh\n");
  chmodSync(join(bin, "present-tool"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.deepEqual(
      checkPrograms(["present-tool", "absent-tool", "bad name"]),
      { "present-tool": true, "absent-tool": false },
    );
  } finally {
    process.env.PATH = path;
  }
});
