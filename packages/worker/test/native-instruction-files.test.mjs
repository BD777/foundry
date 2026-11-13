import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeInstructionFileSettings } from "../dist/session/session-launch-options.js";

const both = {
  pluginConfigs: {
    "cc-plugin-agents-md@builtin": {
      options: { instructionFiles: "claude-md-and-agents-md" },
    },
  },
};

// A person's home with ~/.claude/CLAUDE.md, a Foundry execution configuration
// directory linking it, and a workspace in the home holding only AGENTS.md.
function personHome() {
  const root = mkdtempSync(join(tmpdir(), "agents-md-"));
  const home = join(root, "home");
  const config = join(root, "execution-config");
  const workspace = join(home, "workspace", "repo");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# person\n");
  symlinkSync(join(home, ".claude", "CLAUDE.md"), join(config, "CLAUDE.md"));
  writeFileSync(join(workspace, "AGENTS.md"), "# project\n");
  return {
    root,
    home,
    config,
    workspace,
    env: { CLAUDE_CONFIG_DIR: config },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the person's own CLAUDE.md, seen above the workspace, does not keep AGENTS.md out", () => {
  const h = personHome();
  try {
    assert.deepEqual(nativeInstructionFileSettings(h.workspace, h.env), both);
    // The home itself as workspace: natively the person's file is theirs there too.
    assert.deepEqual(nativeInstructionFileSettings(h.home, h.env), both);
  } finally {
    h.done();
  }
});

test("a project with a CLAUDE.md of its own keeps Claude Code's default", () => {
  for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
    const h = personHome();
    try {
      mkdirSync(join(h.workspace, ".claude"), { recursive: true });
      writeFileSync(join(h.workspace, name), "# project claude\n");
      assert.deepEqual(
        nativeInstructionFileSettings(h.workspace, h.env),
        {},
        name,
      );
    } finally {
      h.done();
    }
  }
  const h = personHome();
  try {
    // A CLAUDE.md in a folder above the project counts the same.
    writeFileSync(join(h.home, "workspace", "CLAUDE.md"), "# parent\n");
    assert.deepEqual(nativeInstructionFileSettings(h.workspace, h.env), {});
  } finally {
    h.done();
  }
});

test("nothing is set where Claude Code already reads AGENTS.md or has no person's file", () => {
  const h = personHome();
  try {
    const outside = join(h.root, "outside");
    mkdirSync(outside);
    assert.deepEqual(nativeInstructionFileSettings(outside, h.env), {});
    rmSync(join(h.config, "CLAUDE.md"));
    assert.deepEqual(nativeInstructionFileSettings(h.workspace, h.env), {});
    assert.deepEqual(nativeInstructionFileSettings(h.workspace, {}), {});
  } finally {
    h.done();
  }
});

test("the person's own instructionFiles choice stands", () => {
  for (const id of ["cc-plugin-agents-md@builtin", "agents-md@builtin"]) {
    const h = personHome();
    try {
      writeFileSync(
        join(h.config, "settings.json"),
        JSON.stringify({
          pluginConfigs: {
            [id]: { options: { instructionFiles: "claude-md" } },
          },
        }),
      );
      assert.deepEqual(
        nativeInstructionFileSettings(h.workspace, h.env),
        {},
        id,
      );
    } finally {
      h.done();
    }
  }
});
