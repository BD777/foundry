import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { composerSlashItems } =
  await import("../src/features/chat/composer/composer-slash.ts");

const item = (value, tag) => ({ value, label: value, tag });

test("the / menu lists each skill name once, as the session resolves it", () => {
  const skills = {
    workspace: [item("code-review"), item("skill-creator"), item("notes")],
    byAgent: {
      claude: {
        official: [
          item("code-review", "Claude Code"),
          item("debug", "Claude Code"),
        ],
        builtin: [item("skill-creator", "Claude Code · Foundry")],
      },
      codex: { official: [item("imagegen", "Codex")], builtin: [] },
    },
  };
  const claude = composerSlashItems(skills, "claude");
  assert.deepEqual(
    claude.map((entry) => `${entry.value}:${entry.tag ?? "workspace"}`),
    [
      "debug:Claude Code",
      "skill-creator:Claude Code · Foundry",
      "code-review:workspace",
      "notes:workspace",
    ],
  );
  assert.deepEqual(
    composerSlashItems(skills, "codex").map((entry) => entry.value),
    ["imagegen", "code-review", "skill-creator", "notes"],
  );
  assert.deepEqual(
    composerSlashItems(skills, undefined).map((entry) => entry.value),
    ["code-review", "skill-creator", "notes"],
  );
});

test("a connector package's skills are listed with their package, a built-in still wins its name", () => {
  const skills = {
    workspace: [
      item("open-lark", "OpenLark package"),
      item("skill-creator", "OpenLark package"),
    ],
    byAgent: {
      claude: { official: [], builtin: [item("skill-creator", "Foundry")] },
    },
  };
  assert.deepEqual(
    composerSlashItems(skills, "claude").map(
      (entry) => `${entry.value}:${entry.tag}`,
    ),
    ["skill-creator:Foundry", "open-lark:OpenLark package"],
  );
});
