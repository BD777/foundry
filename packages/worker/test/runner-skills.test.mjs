import assert from "node:assert/strict";
import test from "node:test";
import { claudeSessionOptions, codexSessionConfig } from "../dist/runner.js";

const managed = (skills, hostSkillPaths = []) => ({
  pluginDir: "/state/skill-sets/abc",
  skills,
  hostSkillPaths,
});

test("Claude filters skills without turning off the device's own settings", () => {
  const options = claudeSessionOptions(managed([]));
  assert.equal(options.settingSources, undefined);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.plugins, []);
});

test("Claude selects only plugin-qualified managed skills", () => {
  const options = claudeSessionOptions(
    managed([{ name: "qa", dir: "/sets/qa" }]),
  );
  assert.deepEqual(options.skills, ["foundry-workspace:qa"]);
  assert.deepEqual(options.plugins, [
    { type: "local", path: "/state/skill-sets/abc" },
  ]);
  assert.match(options.systemPrompt.append, /\/sets\/qa\/SKILL.md/);
});

test("Codex disables native document paths, even a same-name local copy", () => {
  const config = codexSessionConfig(
    managed(
      [{ name: "qa", dir: "/sets/qa" }],
      ["/home/.agents/skills/qa/SKILL.md"],
    ),
  );
  assert.deepEqual(config.skills.config, [
    { enabled: false, path: "/home/.agents/skills/qa/SKILL.md" },
  ]);
  assert.equal(config.skills.include_instructions, false);
  // Codex's own skills are not disabled; only device-installed ones are.
  assert.equal(config.skills.bundled, undefined);
  assert.match(config.developer_instructions, /\/sets\/qa\/SKILL.md/);
  assert.doesNotMatch(config.developer_instructions, /\/home\//);
});

test("Codex empty selections still hide the automatic catalog but keep its own skills", () => {
  assert.equal(
    codexSessionConfig(managed([])).skills.include_instructions,
    false,
  );
  assert.equal(codexSessionConfig(managed([])).skills.bundled, undefined);
  // Its own skills are offered in the catalog, marked built-in.
  const official = codexSessionConfig({
    ...managed([]),
    officialSkills: [
      {
        name: "skill-creator",
        path: "/codex/skills/.system/skill-creator/SKILL.md",
      },
    ],
  });
  assert.match(official.developer_instructions, /"builtIn":true/);
  assert.match(
    official.developer_instructions,
    /\.system\/skill-creator\/SKILL\.md/,
  );
  assert.throws(
    () => codexSessionConfig({ skills: [], pluginDir: "/empty" }),
    /not verified/,
  );
});

test("Codex config disables host skills by path, not by a nonexistent mount API", () => {
  assert.deepEqual(
    codexSessionConfig(managed([], ["/host/qa/SKILL.md"])).skills.config,
    [{ enabled: false, path: "/host/qa/SKILL.md" }],
  );
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

test("device notes reach Claude and Codex with or without a managed catalog", () => {
  const notes = "Foundry device notes: test";
  assert.equal(
    claudeSessionOptions(undefined, notes).systemPrompt.append,
    notes,
  );
  assert.equal(claudeSessionOptions(undefined, notes).skills, undefined);
  assert.deepEqual(claudeSessionOptions(undefined), {});
  const withSkills = claudeSessionOptions(
    managed([{ name: "qa", dir: "/sets/qa" }]),
    notes,
  ).systemPrompt.append;
  assert.ok(
    withSkills.startsWith(notes) && /\/sets\/qa\/SKILL.md/.test(withSkills),
  );
  assert.equal(
    codexSessionConfig(undefined, notes).developer_instructions,
    notes,
  );
  assert.equal(codexSessionConfig(undefined, notes).skills, undefined);
});
