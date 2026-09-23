import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeManagedSkillOptions,
  codexManagedSkillArgs,
  codexManagedSkillConfig,
  tomlBasicString,
} from "../dist/runner.js";

const managed = (skills, hostSkillPaths = []) => ({
  pluginDir: "/state/skill-sets/abc",
  skills,
  hostSkillPaths,
});

test("Claude disables host discovery even for empty selections and direct slash dispatch", () => {
  const options = claudeManagedSkillOptions(managed([]));
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.plugins, []);
});

test("Claude selects only plugin-qualified managed skills", () => {
  const options = claudeManagedSkillOptions(
    managed([{ name: "qa", dir: "/sets/qa" }]),
  );
  assert.deepEqual(options.skills, ["foundry-workspace:qa"]);
  assert.deepEqual(options.plugins, [
    { type: "local", path: "/state/skill-sets/abc" },
  ]);
  assert.match(options.systemPrompt.append, /\/sets\/qa\/SKILL.md/);
});

test("Codex disables native document paths, even a same-name local copy", () => {
  const config = codexManagedSkillConfig(
    managed(
      [{ name: "qa", dir: "/sets/qa" }],
      ["/home/.agents/skills/qa/SKILL.md"],
    ),
  );
  assert.deepEqual(config.skills.config, [
    { enabled: false, path: "/home/.agents/skills/qa/SKILL.md" },
  ]);
  assert.equal(config.skills.include_instructions, false);
  assert.equal(config.skills.bundled.enabled, false);
  assert.match(config.developer_instructions, /\/sets\/qa\/SKILL.md/);
  assert.doesNotMatch(config.developer_instructions, /\/home\//);
});

test("Codex empty selections still disable automatic catalog and bundled skills", () => {
  assert.equal(
    codexManagedSkillConfig(managed([])).skills.include_instructions,
    false,
  );
  assert.ok(
    codexManagedSkillArgs(managed([])).includes("skills.bundled.enabled=false"),
  );
  assert.throws(
    () => codexManagedSkillConfig({ skills: [], pluginDir: "/empty" }),
    /not verified/,
  );
});

test("Codex CLI config uses valid path-only selectors, not a nonexistent mount API", () => {
  const args = codexManagedSkillArgs(managed([], ["/host/qa/SKILL.md"]));
  assert.ok(
    args.includes('skills.config=[{enabled=false,path="/host/qa/SKILL.md"}]'),
  );
});

test("toml basic strings escape quotes and backslashes", () => {
  assert.equal(tomlBasicString('a"b'), '"a\\"b"');
  assert.equal(tomlBasicString("c\\d"), '"c\\\\d"');
});

test("unsafe invocation names are rejected before any package fetch", async () => {
  const { materializeSessionSkills } =
    await import("../dist/skill-materializer.js");
  await assert.rejects(
    () =>
      materializeSessionSkills(
        [
          {
            name: "../escape",
            skillId: "bad",
            revision: 1,
            checksum: "unused",
            byteSize: 1,
          },
        ],
        "http://unused.invalid",
        "/tmp",
      ),
    /unsafe skill invocation name/,
  );
});

test("compatible Codex routing pins the chosen endpoint and native credential variable", async () => {
  const { codexProfileConfig, codexSessionEnvironment } =
    await import("../dist/runner.js");
  const profile = {
    runtime: "codex",
    origin: "server",
    connectionType: "openai_compatible",
    apiKey: "fixture-key",
    baseUrl: "https://gateway.invalid/v1",
  };
  assert.deepEqual(codexProfileConfig(profile), {
    model_provider: "openai",
    openai_base_url: "https://gateway.invalid/v1",
  });
  assert.equal(
    codexSessionEnvironment("/tmp", profile).CODEX_API_KEY,
    "fixture-key",
  );
  assert.deepEqual(
    codexProfileConfig({ ...profile, connectionType: "local_login" }),
    { model_provider: "openai" },
  );
  assert.equal(
    codexSessionEnvironment("/tmp", {
      ...profile,
      connectionType: "local_login",
    }).CODEX_API_KEY,
    "",
  );
});
