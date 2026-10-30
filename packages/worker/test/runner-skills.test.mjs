import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { claudeSessionOptions, codexSessionConfig } from "../dist/runner.js";

const managed = (skills, hostSkillPaths = []) => ({
  pluginDir: "/state/skill-sets/abc",
  skills,
  hostSkillPaths,
});

test("Claude admits managed skills without inheriting device settings", () => {
  const options = claudeSessionOptions(managed([]));
  assert.deepEqual(options.settingSources, []);
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
  assert.deepEqual(claudeSessionOptions(undefined, notes).skills, []);
  assert.deepEqual(claudeSessionOptions(undefined), {
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    skills: [],
    plugins: [],
  });
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

test("both runtimes receive the same instructions, and Foundry adds no delegation guidance", () => {
  for (const [label, catalog, restricted] of [
    ["unmanaged", undefined, false],
    ["ordinary", managed([]), false],
    [
      "draft",
      managed([{ name: "trial", dir: "/trial", draft: { id: "draft" } }]),
      true,
    ],
    ["excluded", { ...managed([]), excludedNames: ["trial"] }, true],
    ["empty exclusion lock", { ...managed([]), excludedNames: [] }, true],
  ]) {
    const claude = claudeSessionOptions(catalog);
    const codex = codexSessionConfig(catalog);
    assert.equal(
      claude.systemPrompt?.append,
      codex.developer_instructions,
      label,
    );
    assert.ok(
      !claude.systemPrompt?.append?.includes("Foundry delegation"),
      label,
    );
    assert.deepEqual(
      claude.disallowedTools,
      restricted ? ["Agent", "Task"] : undefined,
      label,
    );
    assert.equal(
      codex.features?.multi_agent,
      restricted ? false : undefined,
      label,
    );
  }
});

// A large selection, as a workspace with the bytedcli bundle has: Codex got
// every skill in one `--config developer_instructions=…` argument, over the
// 128 KiB Linux allows one argument ("spawn E2BIG").
async function bigSelection(t, count, bundled) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { skillCatalog } = await import("../dist/skill-materializer.js");
  const root = mkdtempSync(join(tmpdir(), "foundry-big-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = [];
  for (let i = 0; i < count; i++) {
    const name = `svc-${String(i).padStart(4, "0")}`;
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\nmetadata:\n  requires: [foundry-absent-tool]\n---\n`,
    );
    skills.push({
      name,
      dir,
      description:
        `Operate the ${name} service: query, deploy, inspect logs and troubleshoot incidents. `.repeat(
          4,
        ),
      ...(bundled
        ? { bundle: { id: "repo_big", name: "bytedcli", version: "0.170.0" } }
        : {}),
    });
  }
  return { root, managed: skillCatalog({ pluginDir: root, skills }) };
}

test("a Codex session with 1000 skills starts with a small argv", async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CodexAppServerThread } =
    await import("../dist/runner/codex-app-server.js");
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
  for (const bundled of [true, false]) {
    const { managed } = await bigSelection(t, 1000, bundled);
    const config = codexSessionConfig(
      { ...managed, hostSkillPaths: ["/home/.agents/skills/qa/SKILL.md"] },
      "Foundry device notes: test",
    );
    const report = join(bin, `argv-${bundled}.json`);
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

test("a large bundle is one catalog entry with an index of its skills", async (t) => {
  const { readFileSync } = await import("node:fs");
  const { largeBundleSkills } = await import("../dist/skill-materializer.js");
  const { managed } = await bigSelection(t, 300, true);
  const single = { name: "qa", dir: "/sets/qa", description: "Quality" };
  const small = Array.from({ length: largeBundleSkills - 1 }, (_, i) => ({
    name: `small-${i}`,
    dir: `/sets/small-${i}`,
    bundle: { id: "repo_small", name: "feishu-cli" },
  }));
  const { skillCatalog } = await import("../dist/skill-materializer.js");
  const catalog = skillCatalog({
    ...managed,
    skills: [...managed.skills, single, ...small],
  });
  assert.equal(catalog.indexes.length, 1);
  const [index] = catalog.indexes;
  assert.equal(index.name, "bytedcli");
  assert.equal(index.skills.length, 300);
  const listing = readFileSync(index.file, "utf8");
  assert.match(listing, /^# bytedcli 0\.170\.0/);
  for (const skill of managed.skills)
    assert.ok(
      listing.includes(`- ${skill.name}: `) &&
        listing.includes(`${skill.dir}/SKILL.md`),
    );
  for (const options of [
    claudeSessionOptions(catalog).systemPrompt.append,
    codexSessionConfig({ ...catalog, hostSkillPaths: [] })
      .developer_instructions,
  ]) {
    const entries = options
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    // The single skill and the small bundle's are listed one by one.
    assert.deepEqual(
      entries.filter((entry) => entry.name).map((entry) => entry.name),
      ["qa", ...small.map((skill) => skill.name)],
    );
    assert.deepEqual(
      entries.filter((entry) => entry.bundle),
      [
        {
          bundle: "bytedcli",
          version: "0.170.0",
          description: "",
          skills: 300,
          index: index.file,
        },
      ],
    );
    assert.ok(
      Buffer.byteLength(options) < 8 * 1024,
      `${Buffer.byteLength(options)} bytes`,
    );
    // One line per missing program, however many skills need it.
    assert.match(
      options,
      /foundry-absent-tool \(needed by svc-0000, .* and 295 more\)/,
    );
  }
  // A folded entry remains directly selectable in both runtime paths;
  // naming one does not insert its siblings' method bodies into the prompt.
  const { validateWorkspaceSkillPrompt, claudeManagedPrompt } =
    await import("../dist/skill-isolation.js");
  assert.doesNotThrow(() =>
    validateWorkspaceSkillPrompt("$svc-0299 inspect", catalog),
  );
  assert.doesNotThrow(() =>
    validateWorkspaceSkillPrompt("/svc-0299 inspect", catalog),
  );
  assert.equal(
    claudeManagedPrompt("/svc-0299 inspect", catalog),
    "/foundry-workspace:svc-0299 inspect",
  );
  // Every skill stays invocable in Claude.
  assert.equal(
    claudeSessionOptions(catalog).skills.length,
    300 + 1 + small.length,
  );
});

test("skills past the catalog budget share one index", async (t) => {
  const { skillCatalogBudget } = await import("../dist/skill-materializer.js");
  const { managed } = await bigSelection(t, 1000, false);
  assert.equal(managed.indexes.length, 1);
  const [overflow] = managed.indexes;
  assert.equal(overflow.bundleId, undefined);
  const append = claudeSessionOptions(managed).systemPrompt.append;
  const listed = append
    .split("\n")
    .filter((line) => line.startsWith('{"name"'));
  assert.equal(listed.length + overflow.skills.length, 1000);
  assert.ok(listed.join("\n").length <= skillCatalogBudget);
  assert.match(append, /"group":"more workspace skills"/);
});

test("a new skill set downloads only the revisions no set holds yet", async (t) => {
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { packZip } = await import("../dist/skill-zip.js");
  const { materializeSessionSkills } =
    await import("../dist/skill-materializer.js");
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
  assert.equal(second.skills.find((s) => s.name === "s1").description, "s1 r1");
  const { writeFileSync } = await import("node:fs");
  const bundled = [updated, ...refs.slice(1)].map((ref) => ({
    ...ref,
    bundle: { id: "bundle", name: "Original bundle", version: "1" },
  }));
  const grouped = await materializeSessionSkills(bundled, url, "/tmp");
  assert.equal(grouped.indexes.length, 1);
  writeFileSync(grouped.indexes[0].file, "forged index");
  const repaired = await materializeSessionSkills(bundled, url, "/tmp");
  assert.notEqual(repaired.pluginDir, grouped.pluginDir);
  assert.match(
    readFileSync(repaired.indexes[0].file, "utf8"),
    /Original bundle/,
  );
  const renamed = await materializeSessionSkills(
    bundled.map((ref) => ({
      ...ref,
      bundle: { ...ref.bundle, name: "Renamed bundle" },
    })),
    url,
    "/tmp",
  );
  assert.notEqual(renamed.pluginDir, repaired.pluginDir);
  assert.match(readFileSync(renamed.indexes[0].file, "utf8"), /Renamed bundle/);
  assert.equal(
    requested.length,
    31,
    "generated indexes repair from verified archives",
  );
});

test("cached skill generations verify all bytes and preserve active paths on repair", async (t) => {
  const { createServer } = await import("node:http");
  const { createHash, randomUUID } = await import("node:crypto");
  const { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { packZip } = await import("../dist/skill-zip.js");
  const { materializeSessionSkills } =
    await import("../dist/skill-materializer.js");
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
  const { foundryStatePath } = await import("../dist/state-root.js");
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
