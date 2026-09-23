// Native discovery acceptance. No model requests, account changes, or host skill edits.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
const base = new URL("../dist/", import.meta.url).href;
const runner = await import(base + "runner.js");
const { resolveClaudeCommand } = await import(base + "utils.js");
const { activeClaudeRuntimes } = await import(base + "session-state.js");
const { prepareCodexSkillIsolation, validateWorkspaceSkillPrompt } =
  await import(base + "skill-isolation.js");
const { withCodexControl } = await import(base + "native-inspection.js");
const { materializeSessionSkills } = await import(
  base + "skill-materializer.js"
);
const { packZip } = await import(base + "skill-zip.js");
const dir = mkdtempSync(join(tmpdir(), "foundry-isolation-"));
process.env.FOUNDRY_STATE_ROOT = join(dir, "state");
process.env.FOUNDRY_EXECUTION_SESSION_ROOT = join(dir, "sessions");
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
const receipt = { checks: [] };
try {
  for (const m of [managed, empty]) {
    let release;
    const wait = new Promise((r) => (release = r));
    const q = query({
      prompt: (async function* () {
        await wait;
      })(),
      options: {
        ...runner.claudeManagedSkillOptions(m, cwd),
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
        m.skills.length > 0,
      );
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
    }
  }
  const codex = await prepareCodexSkillIsolation(managed, cwd, process.env);
  assert(codex.hostSkillPaths.some((p) => p.includes("isolation-local-only")));

  const result = await withCodexControl(
    "",
    (call) => call("skills/list", { cwds: [cwd], forceReload: true }),
    { cwd, env: process.env, args: runner.codexManagedSkillArgs(codex) },
  );
  const enabled = result.data.flatMap((x) => x.skills).filter((x) => x.enabled);
  assert.deepEqual(enabled, []);
  receipt.checks.push({
    runtime: "codex",
    disabledNativeSkills: codex.hostSkillPaths.length,
    enabledNativeSkills: 0,
    managedCatalog: true,
  });
  for (const name of ["ccm-domain-mapping", "isolation-local-only"])
    assert.throws(
      () => validateWorkspaceSkillPrompt("/" + name + " run", managed),
      /not configured/,
    );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const rt of activeClaudeRuntimes.values())
    runner.closeActiveClaudeRuntime(rt);
  activeClaudeRuntimes.clear();
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
