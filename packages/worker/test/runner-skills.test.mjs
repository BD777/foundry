import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { claudeSessionOptions } from "../dist/session/session-launch-options.js";
import { codexSessionConfig } from "../dist/session/runner/codex-options.js";

const managed = (skills) => ({
  pluginDir: "/state/skill-sets/abc",
  skills,
});

test("a workspace session loads the native settings; a utility session none", () => {
  const options = claudeSessionOptions(managed([]));
  assert.equal(options.settingSources, undefined);
  assert.equal(options.skills, undefined);
  assert.deepEqual(options.plugins, []);
  const utility = claudeSessionOptions(
    managed([{ name: "qa", dir: "/sets/qa" }]),
    "",
    true,
  );
  assert.deepEqual(utility.settingSources, []);
  assert.deepEqual(utility.skills, []);
  assert.deepEqual(utility.plugins, []);
});

test("Claude gets managed skills as a plugin and lists them itself", () => {
  const options = claudeSessionOptions(
    managed([{ name: "qa", dir: "/sets/qa" }]),
  );
  assert.equal(options.skills, undefined);
  assert.deepEqual(options.plugins, [
    { type: "local", path: "/state/skill-sets/abc" },
  ]);
  // Claude Code lists a plugin's skills natively: no catalog of Foundry's.
  assert.equal(options.systemPrompt, undefined);
});

test("Codex finds skills natively: Foundry disables none and writes no catalog", () => {
  for (const catalog of [
    managed(
      [{ name: "qa", dir: "/sets/qa" }],
      ["/home/.agents/skills/qa/SKILL.md"],
    ),
    managed([]),
    { skills: [], pluginDir: "/empty" },
  ]) {
    const config = codexSessionConfig(catalog, "Foundry device notes: test");
    assert.equal(config.skills, undefined);
    assert.equal(config.developer_instructions, "Foundry device notes: test");
  }
});

test("managed skills are linked where Codex looks, beside the person's own", async (t) => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readlinkSync,
    lstatSync,
    readFileSync,
    rmSync,
    existsSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { foundryStatePath } = await import("../dist/platform/state-root.js");
  const { linkCodexSkills } =
    await import("../dist/skills/codex-native-skills.js");
  const set = foundryStatePath("skill-sets", `test-${process.pid}`);
  const workspace = mkdtempSync(join(tmpdir(), "foundry-codex-skills-"));
  t.after(() => {
    rmSync(set, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  for (const name of ["qa", "mine", "old"]) {
    mkdirSync(join(set, name), { recursive: true });
    writeFileSync(join(set, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  execFileSync("git", ["init", "-q", workspace]);
  // The person's own skill of the same name stays.
  mkdirSync(join(workspace, ".agents", "skills", "mine"), { recursive: true });
  const at = (name) => join(workspace, ".agents", "skills", name);
  linkCodexSkills(
    { pluginDir: set, skills: [{ name: "old", dir: join(set, "old") }] },
    workspace,
  );
  assert.equal(readlinkSync(at("old")), join(set, "old"));
  linkCodexSkills(
    {
      pluginDir: set,
      skills: [
        { name: "qa", dir: join(set, "qa") },
        { name: "mine", dir: join(set, "mine") },
        { name: "draft", dir: "/elsewhere", draft: { id: "d" } },
      ],
    },
    workspace,
  );
  assert.equal(readlinkSync(at("qa")), join(set, "qa"));
  assert.ok(!lstatSync(at("mine")).isSymbolicLink());
  assert.ok(!existsSync(at("old")) && !existsSync(at("draft")));
  const exclude = readFileSync(
    join(workspace, ".git", "info", "exclude"),
    "utf8",
  );
  assert.match(exclude, /^\/\.agents\/skills\/qa$/m);
  assert.doesNotMatch(exclude, /skills\/mine$/m);
});

test("unsafe invocation names are rejected before any package fetch", async () => {
  const { materializeSessionSkills } =
    await import("../dist/skills/skill-materializer.js");
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
    await import("../dist/session/runner/codex-options.js");
  const profile = {
    runtime: "codex",
    origin: "server",
    connectionType: "openai_compatible",
    apiKey: "fixture-key",
    baseUrl: "https://gateway.invalid/v1",
  };
  const env = codexSessionEnvironment("/tmp", profile);
  assert.equal(env.CODEX_API_KEY, "fixture-key");
  // Its own provider, not the built-in openai one that tries the Responses
  // WebSocket first.
  assert.deepEqual(codexProfileConfig({ ...profile, id: "gw.1" }, env), {
    model_provider: "foundry_gw_1",
    model_providers: {
      foundry_gw_1: {
        name: "foundry_gw_1",
        base_url: "https://gateway.invalid/v1",
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
        supports_websockets: false,
      },
    },
  });
  // A keyless endpoint names no env_key: Codex refuses an unset one.
  assert.deepEqual(codexProfileConfig({ ...profile, label: "Gateway" }, {}), {
    model_provider: "foundry",
    model_providers: {
      foundry: {
        name: "Gateway",
        base_url: "https://gateway.invalid/v1",
        wire_api: "responses",
        supports_websockets: false,
      },
    },
  });
  assert.deepEqual(
    codexProfileConfig({ ...profile, connectionType: "local_login" }, env),
    { model_provider: "openai" },
  );
  assert.deepEqual(
    codexProfileConfig({ ...profile, codexModelProvider: "relay" }, env),
    codexProfileConfig(profile, env),
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
  assert.deepEqual(claudeSessionOptions(undefined), {
    mcpServers: {},
    plugins: [],
  });
  assert.equal(
    claudeSessionOptions(managed([{ name: "qa", dir: "/sets/qa" }]), notes)
      .systemPrompt.append,
    notes,
  );
  assert.equal(
    codexSessionConfig(undefined, notes).developer_instructions,
    notes,
  );
  assert.equal(codexSessionConfig(undefined, notes).skills, undefined);
});

test("native subagents stay on, drafts or not", () => {
  for (const [label, catalog] of [
    ["unmanaged", undefined],
    ["ordinary", managed([])],
    [
      "workspace with a draft",
      managed([{ name: "trial", dir: "/trial", draft: { id: "draft" } }]),
    ],
  ]) {
    const claude = claudeSessionOptions(catalog);
    const codex = codexSessionConfig(catalog);
    assert.equal(claude.disallowedTools, undefined, label);
    assert.equal(codex.features?.multi_agent, undefined, label);
  }
});

// A large selection, as a workspace with the corpcli bundle has: Codex got
// every skill in one `--config developer_instructions=…` argument, over the
// 128 KiB Linux allows one argument ("spawn E2BIG").
function bigSelection(count) {
  const skills = Array.from({ length: count }, (_, i) => {
    const name = `svc-${String(i).padStart(4, "0")}`;
    return {
      name,
      dir: `/state/skill-sets/big/skills/${name}`,
      bundle: { id: "repo_big", name: "corpcli", version: "0.170.0" },
    };
  });
  return { pluginDir: "/state/skill-sets/big", skills };
}

test("a Codex session with 1000 skills starts with a small argv", async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CodexAppServerThread } =
    await import("../dist/session/runner/codex-app-server.js");
  const bin = mkdtempSync(join(tmpdir(), "foundry-fake-codex-"));
  const fake = join(bin, "codex");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.ARGV_REPORT, JSON.stringify(process.argv.slice(2).map((a) => Buffer.byteLength(a) + 1)));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};if(m.method==='thread/start')result={thread:{id:'test'}};
 if(m.method==='turn/start')result={turn:{id:'t'}};
 console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='turn/start')setTimeout(()=>console.log(JSON.stringify({method:'turn/completed',params:{threadId:'test',turn:{id:'t',status:'completed'}}})),5);
});\n`,
  );
  chmodSync(fake, 0o755);
  {
    const managed = bigSelection(1000);
    const config = codexSessionConfig(managed, "Foundry device notes: test");
    const report = join(bin, "argv.json");
    const codex = new CodexAppServerThread(
      fake,
      { PATH: process.env.PATH ?? "", ARGV_REPORT: report },
      config,
      { workingDirectory: bin },
    );
    const turn = await codex.runStreamed("reply OK");
    for await (const _ of turn.events);
    const sizes = JSON.parse(readFileSync(report, "utf8"));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    // Linux: 128 KiB per argument, about 2 MiB for all of them.
    assert.ok(
      Math.max(...sizes) < 32 * 1024,
      `largest argument ${Math.max(...sizes)}`,
    );
    assert.ok(total < 48 * 1024, `argv ${total} bytes`);
  }
});

test("a large bundle reaches the agents only as native skills", () => {
  const managed = bigSelection(300);
  // Claude Code and Codex list the skills themselves, within their own
  // budgets: Foundry writes no catalog or index into what they are told.
  const claude = claudeSessionOptions(managed);
  assert.equal(claude.systemPrompt, undefined);
  assert.deepEqual(claude.plugins, [
    { type: "local", path: "/state/skill-sets/big" },
  ]);
  assert.deepEqual(codexSessionConfig(managed), {});
});

test("a new skill set downloads only the revisions no set holds yet", async (t) => {
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { packZip } = await import("../dist/skills/skill-zip.js");
  const { materializeSessionSkills } =
    await import("../dist/skills/skill-materializer.js");
  const packages = new Map();
  const ref = (name, revision) => {
    const zip = packZip([
      {
        path: "SKILL.md",
        data: Buffer.from(
          `---\nname: ${name}\ndescription: ${name} r${revision}\n---\nr${revision}\n`,
        ),
      },
    ]);
    const skillId = `skill-${name}-${process.pid}-${Date.now()}`;
    packages.set(
      `/api/skills/catalog/${skillId}/revisions/${revision}/package`,
      zip,
    );
    return {
      skillId,
      revision,
      name,
      checksum: createHash("sha256").update(zip).digest("hex"),
      byteSize: zip.length,
    };
  };
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    const zip = packages.get(request.url);
    response.writeHead(zip ? 200 : 404);
    response.end(zip);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const refs = Array.from({ length: 30 }, (_, i) => ref(`s${i}`, 1));
  const first = await materializeSessionSkills(refs, url, "/tmp");
  assert.equal(requested.length, 30);
  const updated = ref("s0", 2);
  updated.skillId = refs[0].skillId;
  packages.set(
    `/api/skills/catalog/${updated.skillId}/revisions/2/package`,
    packages.get([...packages.keys()].pop()),
  );
  const second = await materializeSessionSkills(
    [updated, ...refs.slice(1)],
    url,
    "/tmp",
  );
  assert.notEqual(second.pluginDir, first.pluginDir);
  assert.equal(requested.length, 31);
  assert.match(
    readFileSync(
      join(second.skills.find((s) => s.name === "s0").dir, "SKILL.md"),
      "utf8",
    ),
    /r2/,
  );
  // A set holds only the skills and the plugin manifest, never an index.
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(second.pluginDir, "skill-indexes")), false);
});

test("cached skill generations verify all bytes and preserve active paths on repair", async (t) => {
  const { createServer } = await import("node:http");
  const { createHash, randomUUID } = await import("node:crypto");
  const { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { packZip } = await import("../dist/skills/skill-zip.js");
  const { materializeSessionSkills } =
    await import("../dist/skills/skill-materializer.js");
  const zip = packZip([
    {
      path: "SKILL.md",
      data: Buffer.from(
        "---\nname: integrity\ndescription: verified archive\n---\nOriginal instruction\n",
      ),
    },
    { path: "scripts/run.js", data: Buffer.from("console.log('original');\n") },
  ]);
  const ref = {
    skillId: randomUUID(),
    name: "integrity",
    revision: 1,
    checksum: createHash("sha256").update(zip).digest("hex"),
    byteSize: zip.length,
  };
  let requested = 0;
  const server = createServer((_req, response) => {
    requested++;
    response.end(zip);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const materialize = () => materializeSessionSkills([ref], url, "/tmp");
  let current = await materialize();
  const original = current.pluginDir;
  assert.equal((await materialize()).pluginDir, original);
  assert.equal(requested, 1);
  for (const change of [
    (root) =>
      writeFileSync(
        join(root, "skills/integrity/SKILL.md"),
        "tampered instruction",
      ),
    (root) =>
      writeFileSync(
        join(root, "skills/integrity/scripts/run.js"),
        "tampered script",
      ),
    (root) =>
      writeFileSync(
        join(root, ".foundry-input-snapshot.json"),
        "forged marker",
      ),
    (root) => writeFileSync(join(root, ".claude-plugin/plugin.json"), "{}"),
    (root) => mkdirSync(join(root, "extra")),
    (root) => {
      const script = join(root, "skills/integrity/scripts/run.js");
      rmSync(script);
      symlinkSync("/etc/passwd", script);
    },
  ]) {
    const held = current.pluginDir;
    change(held);
    const [next, concurrent] = await Promise.all([
      materialize(),
      materialize(),
    ]);
    assert.equal(next.pluginDir, concurrent.pluginDir);
    assert.notEqual(next.pluginDir, held);
    assert.equal(next.snapshotDigest, concurrent.snapshotDigest);
    assert.match(
      readFileSync(join(next.skills[0].dir, "SKILL.md"), "utf8"),
      /Original instruction/,
    );
    assert.equal(
      readFileSync(join(next.skills[0].dir, "scripts/run.js"), "utf8"),
      "console.log('original');\n",
    );
    assert.equal(
      readFileSync(
        join(next.pluginDir, ".claude-plugin/plugin.json"),
        "utf8",
      ).includes("foundry-workspace"),
      true,
    );
    // Repair must leave a generation held by another execution in place.
    assert.ok(readFileSync(join(held, "skills/integrity/SKILL.md")).length);
    current = next;
  }
  assert.equal(
    requested,
    1,
    "verified archives supply repairs without a network request",
  );
  const { foundryStatePath } = await import("../dist/platform/state-root.js");
  writeFileSync(
    foundryStatePath("skill-archives", `${ref.checksum}.zip`),
    "bad archive",
  );
  assert.equal((await materialize()).pluginDir, current.pluginDir);
  assert.equal(
    requested,
    2,
    "archive bytes are checked independently from a valid generation",
  );
});
