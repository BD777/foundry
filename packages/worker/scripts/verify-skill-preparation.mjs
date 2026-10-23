// Installed native-runtime discovery probe. No inference, account changes or
// host Skill edits; all generated packages and native execution state are scratch.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "foundry-skill-preparation-"));
process.env.FOUNDRY_STATE_ROOT = join(root, "state");
process.env.FOUNDRY_EXECUTION_SESSION_ROOT = join(root, "sessions");
for (const key of Object.keys(process.env)) {
  if (
    /^(?:FOUNDRY_NATIVE_|FOUNDRY_CODEX_AUTH_SOURCE$|ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$)/.test(
      key,
    )
  )
    delete process.env[key];
}
const { materializeSessionSkills } =
  await import("../dist/skill-materializer.js");
const { skillContentDigest } = await import("../dist/skill-content-cache.js");
const { packZip } = await import("../dist/skill-zip.js");
const { prepareExecution } =
  await import("../dist/session/preparation/index.js");
const { claudeSessionOptions } = await import("../dist/session-policy.js");
const { codexSessionConfig } = await import("../dist/runner/codex-options.js");
const { validateWorkspaceSkillPrompt } =
  await import("../dist/skill-isolation.js");
const { resolveClaudeCommand } = await import("../dist/native-cli.js");
const { withCodexControl } = await import("../dist/native-inspection.js");
const { loadClaudeSdk } = await import("../dist/agent-runtime/claude-sdk.js");
const { stringify } = await import("smol-toml");
const cwd = join(root, "workspace");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(root, "state", "skill-archives"), { recursive: true });
const refs = Array.from({ length: 24 }, (_, i) => {
  const name = `preparation-probe-${i}`;
  const files = [
    {
      path: "SKILL.md",
      data: Buffer.from(
        `---\nname: ${name}\ndescription: Synthetic discovery probe ${i}\n---\nPROBE_BODY_${i}`,
      ),
    },
  ];
  const zip = packZip(files),
    checksum = createHash("sha256").update(zip).digest("hex");
  writeFileSync(join(root, "state", "skill-archives", `${checksum}.zip`), zip);
  return {
    skillId: name,
    name,
    revision: 1,
    checksum,
    byteSize: zip.length,
    sourceDigest: skillContentDigest(files),
    bundle: { id: "probe", name: "Probe bundle" },
  };
});
const receipt = { inferenceRequests: 0, checks: [] };
try {
  await materializeSessionSkills(refs, "", cwd);
  const managed = await materializeSessionSkills(refs, "", cwd, {
    onComplete: (stats) => {
      receipt.preparation = stats;
    },
  });
  assert.equal(receipt.preparation.expandedCache, refs.length);
  assert.equal(receipt.preparation.unpackMs, 0);
  assert.equal(managed.indexes.length, 1);
  validateWorkspaceSkillPrompt("/preparation-probe-23 inspect", managed);
  validateWorkspaceSkillPrompt("$preparation-probe-23 inspect", managed);
  for (const runtime of ["claude", "codex"]) {
    const execution = await prepareExecution(
      {
        purpose: "workspace",
        ownerId: `preparation-${runtime}`,
        workspacePath: cwd,
        profile: {
          runtime,
          connectionType:
            runtime === "claude" ? "anthropic_compatible" : "openai_compatible",
          id: "preparation-discovery",
        },
        session: { id: `preparation-${runtime}` },
        managedSkills: managed,
      },
      { resolveWindow: async () => undefined },
    );
    try {
      if (runtime === "claude") {
        const { query } = await loadClaudeSdk();
        let release;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const q = query({
          prompt: (async function* () {
            await wait;
          })(),
          options: {
            ...claudeSessionOptions(managed),
            env: execution.native.env,
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
          for (const ref of refs)
            assert.ok(
              commands.includes(`foundry-workspace:${ref.name}`),
              ref.name,
            );
          receipt.checks.push({
            runtime,
            individuallyInvocable: refs.length,
            foldedCatalog: true,
          });
        } finally {
          clearTimeout(timer);
          q.close();
          release();
          await q.dispose();
        }
      } else {
        const config = codexSessionConfig(execution.native.managedSkills);
        assert.ok(
          config.developer_instructions.includes('"bundle":"Probe bundle"'),
        );
        assert.ok(!config.developer_instructions.includes("PROBE_BODY_"));
        const { appendFileSync } = await import("node:fs");
        appendFileSync(
          join(execution.native.env.CODEX_HOME, "config.toml"),
          stringify(config),
        );
        const inventory = await withCodexControl(
          "",
          (call) => call("skills/list", { cwds: [cwd], forceReload: true }),
          { cwd, env: execution.native.env, args: [] },
        );
        const enabled = inventory.data
          .flatMap((row) => row.skills)
          .filter((skill) => skill.enabled);
        const allowed = new Set(
          execution.native.managedSkills.officialSkills.map(
            (skill) => skill.path,
          ),
        );
        assert.ok(enabled.every((skill) => allowed.has(skill.path)));
        receipt.checks.push({
          runtime,
          nativeInventoryChecked: true,
          workspaceCatalogFolded: true,
          bodiesNotInjected: true,
          explicitMemberValidated: true,
        });
      }
    } finally {
      await execution.dispose();
    }
  }
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
