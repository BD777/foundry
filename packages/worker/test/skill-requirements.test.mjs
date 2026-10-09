import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrograms,
  skillToolRequirements,
} from "../dist/skill-requirements.js";
import { workspaceSkillInstructions } from "../dist/skill-isolation.js";

function skill(files) {
  const dir = mkdtempSync(join(tmpdir(), "skill-req-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("a skill needs what it declares, its scripts' interpreters and shebang programs", () => {
  const dir = skill({
    "SKILL.md": "---\nname: demo\nmetadata:\n  requires: ffmpeg, python\n---\n",
    "scripts/a.py": "print(1)",
    "scripts/run": "#!/usr/bin/env -S node --no-warnings\n",
    "scripts/b.sh": "#!/bin/sh\n",
    "reference.md": "#!/usr/bin/env not-a-program\n",
  });
  assert.deepEqual(skillToolRequirements(dir), [
    "bash",
    "ffmpeg",
    "node",
    "python3",
  ]);
});

test("programs are checked on PATH and missing ones reach the session", () => {
  const bin = mkdtempSync(join(tmpdir(), "skill-bin-"));
  writeFileSync(join(bin, "present-tool"), "#!/bin/sh\n");
  chmodSync(join(bin, "present-tool"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.deepEqual(
      checkPrograms(["present-tool", "absent-tool", "bad name"]),
      {
        "present-tool": true,
        "absent-tool": false,
      },
    );
    const dir = skill({
      "SKILL.md":
        "---\nname: demo\nmetadata:\n  requires: [present-tool, absent-tool]\n---\n",
    });
    const policy = workspaceSkillInstructions({
      pluginDir: "/p",
      skills: [{ name: "demo", dir }],
    });
    assert.match(policy, /missing on this device: demo needs absent-tool\./);
    assert.doesNotMatch(policy, /present-tool\b.*missing/);
  } finally {
    process.env.PATH = path;
  }
});
