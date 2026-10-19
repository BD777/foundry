// Native discovery acceptance. No model requests, account changes, or host skill edits.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { stringify } from "smol-toml";
const base = new URL("../dist/", import.meta.url).href;
const { claudeSessionOptions } = await import(base + "session-policy.js");
const { codexSessionConfig } = await import(base + "runner/codex-options.js");
const { prepareExecution } = await import(
  base + "session/preparation/index.js"
);
const { query } = await (
  await import(base + "agent-runtime/claude-sdk.js")
).loadClaudeSdk();
const { resolveClaudeCommand } = await import(base + "native-cli.js");
const { validateWorkspaceSkillPrompt } = await import(
  base + "skill-isolation.js"
);
const { withCodexControl } = await import(base + "native-inspection.js");
const { materializeSessionSkills } = await import(
  base + "skill-materializer.js"
);
const { packZip } = await import(base + "skill-zip.js");
const dir = mkdtempSync(join(tmpdir(), "foundry-isolation-"));
process.env.FOUNDRY_STATE_ROOT = join(dir, "state");
process.env.FOUNDRY_EXECUTION_SESSION_ROOT = join(dir, "sessions");
process.env.HOME = dir;
process.env.CODEX_HOME = join(dir, "codex-source");
process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-source");
for (const key of Object.keys(process.env)) {
  if (
    /^(?:FOUNDRY_NATIVE_|FOUNDRY_CODEX_AUTH_SOURCE$|ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$)/.test(
      key,
    )
  )
    delete process.env[key];
}
const cwd = join(dir, "workspace");
mkdirSync(cwd, { recursive: true });
const marker = "WORKSPACE_ONLY_" + randomUUID();
const skillText = `---\nname: isolation-selected\ndescription: Return the workspace isolation verification token when asked.\n---\nWhen invoked, reply exactly: ${marker}\n`;
for (const root of [".claude", ".agents"]) {
  const path = join(cwd, root, "skills", "isolation-local-only");
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    "---\nname: isolation-local-only\ndescription: Device local unselected isolation fixture.\n---\nReply LOCAL_SKILL_LEAKED.",
  );
}
for (const root of [".claude", ".agents"]) {
  const path = join(cwd, root, "skills", "isolation-selected");
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    "---\nname: isolation-selected\ndescription: Wrong local copy with a selected skill name.\n---\nLOCAL_WRONG_COPY",
  );
}
const archive = packZip([{ path: "SKILL.md", data: Buffer.from(skillText) }]);
const srv = createServer((req, res) => res.end(archive));
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const ref = {
  skillId: "isolation-selected",
  name: "isolation-selected",
  revision: 1,
  checksum: createHash("sha256").update(archive).digest("hex"),
  byteSize: archive.length,
};
const managed = await materializeSessionSkills(
  [ref],
  `http://127.0.0.1:${srv.address().port}`,
  cwd,
);
const empty = await materializeSessionSkills([], "", cwd);
const { withWorkspaceDraftSkills } = await import(
  base + "workspace-skill-runtime.js"
);
const draftDir = join(cwd, ".agents", "skills", "trial-native");
mkdirSync(draftDir, { recursive: true });
writeFileSync(
  join(draftDir, "SKILL.md"),
  "---\nname: trial-native\ndescription: Isolated draft invocation fixture.\n---\nReply DRAFT_ONLY.",
);
const dependentDir = join(cwd, ".agents", "skills", "trial-dependent");
mkdirSync(dependentDir, { recursive: true });
writeFileSync(
  join(dependentDir, "SKILL.md"),
  "---\nname: trial-dependent\ndescription: Draft with an explicit method dependency.\n---\nRead ../trial-native/SKILL.md before answering.",
);
const draftRuntime = await withWorkspaceDraftSkills(managed, {
  workspaceId: "acceptance",
  executionRootId: "acceptance",
  workspacePath: cwd,
});
const receipt = { checks: [] };
try {
  for (const m of [managed, empty, draftRuntime]) {
    let release;
    const wait = new Promise((r) => (release = r));
    const prepared = await prepareExecution(
      {
        purpose: "workspace",
        ownerId: "claude-acceptance",
        workspacePath: cwd,
        profile: {
          runtime: "claude",
          connectionType: "anthropic_compatible",
          id: "acceptance",
        },
        session: { id: "claude-acceptance" },
        managedSkills: m,
      },
      { resolveWindow: async () => undefined },
    );
    const q = query({
      prompt: (async function* () {
        await wait;
      })(),
      options: {
        ...claudeSessionOptions(m),
        env: prepared.native.env,
        cwd,
        pathToClaudeCodeExecutable: resolveClaudeCommand(),
        persistSession: false,
        tools: [],
        settings: { disableBundledSkills: true },
      },
    });
    const timer = setTimeout(() => q.close(), 20000);
    try {
      const commands = (await q.supportedCommands()).map((c) => c.name);
      assert(!commands.includes("ccm-domain-mapping"));
      assert(!commands.includes("isolation-local-only"));
      assert(!commands.includes("isolation-selected"));
      assert.equal(
        commands.includes("foundry-workspace:isolation-selected"),
        m.skills.some((skill) => skill.name === "isolation-selected"),
      );
      for (const skill of m.skills)
        assert(
          commands.includes(`foundry-workspace:${skill.name}`),
          `native draft invocation missing: ${skill.name}`,
        );
      if (m.draftsEnabled)
        assert.deepEqual(claudeSessionOptions(m).disallowedTools, [
          "Agent",
          "Task",
        ]);
      receipt.checks.push({
        runtime: "claude",
        selected: m.skills.length,
        hostSkillsAbsent: true,
        managedFound: m.skills.length > 0,
      });
    } finally {
      clearTimeout(timer);
      q.close();
      release();
      await q.dispose();
      await prepared.dispose();
    }
  }
  const prepared = await prepareExecution(
    {
      purpose: "workspace",
      ownerId: "codex-acceptance",
      workspacePath: cwd,
      profile: {
        runtime: "codex",
        connectionType: "openai_compatible",
        id: "acceptance",
      },
      session: { id: "codex-acceptance" },
      managedSkills: managed,
    },
    { resolveWindow: async () => undefined },
  );
  const codex = prepared.native.managedSkills;
  appendFileSync(
    join(prepared.native.env.CODEX_HOME, "config.toml"),
    stringify(codexSessionConfig(codex)),
  );
  assert(codex.hostSkillPaths.some((p) => p.includes("isolation-local-only")));

  const result = await withCodexControl(
    "",
    (call) => call("skills/list", { cwds: [cwd], forceReload: true }),
    { cwd, env: prepared.native.env, args: [] },
  );
  const enabled = result.data.flatMap((x) => x.skills).filter((x) => x.enabled);
  const allowed = new Set(codex.officialSkills.map((skill) => skill.path));
  assert(enabled.every((skill) => allowed.has(skill.path)));
  assert(allowed.size > 0, "the native official-skill inventory is present");
  assert.equal(
    enabled.length,
    allowed.size,
    "every official skill stays enabled",
  );
  await prepared.dispose();
  receipt.checks.push({
    runtime: "codex",
    disabledNativeSkills: codex.hostSkillPaths.length,
    enabledNativeSkills: enabled.length,
    onlyOfficialNativeSkills: true,
    managedCatalog: true,
  });
  for (const name of ["ccm-domain-mapping", "isolation-local-only"])
    assert.throws(
      () => validateWorkspaceSkillPrompt("/" + name + " run", managed),
      /not configured/,
    );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
