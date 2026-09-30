import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  codexDisabledFeatures as stageDisabledFeatures,
  codexStageConfig,
  stageLauncher as stageSandboxExecutable,
} from "../dist/session/index.js";
import { sandboxAvailable } from "../dist/sandbox/index.js";
import { digestObject, digestBytes } from "../dist/evidence-store.js";

test(
  "a detached stage reads only its own home and cannot touch original evidence",
  { skip: !sandboxAvailable("readonly_agent") },
  (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-verifier-isolation-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = resolve(root, "selected");
    mkdirSync(home);
    const original = resolve(root, "original.txt");
    writeFileSync(original, "private material");
    writeFileSync(resolve(home, "selected.txt"), "selected");
    const executable = stageSandboxExecutable(process.execPath, home);
    const script = `const fs=require("fs");console.log(fs.readFileSync("selected.txt","utf8"));for(const op of [()=>fs.readFileSync(${JSON.stringify(original)}),()=>fs.writeFileSync(${JSON.stringify(original)},"changed")]){try{op();process.exit(9)}catch(e){if(!["EPERM","EACCES","EROFS","ENOENT"].includes(e.code))throw e;}}`;
    const output = execFileSync(executable, ["-e", script], {
      cwd: root,
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.match(output, /selected/);
    assert.equal(readFileSync(original, "utf8"), "private material");
    for (const key of [
      "shell_tool",
      "apps",
      "browser_use",
      "computer_use",
      "multi_agent",
      "plugins",
      "hooks",
    ])
      assert.equal(stageDisabledFeatures(false)[key], false);
    // A stage that works inside a directory keeps its read-only shell.
    assert.equal(stageDisabledFeatures(true).shell_tool, undefined);
    assert.equal(stageDisabledFeatures(true).browser_use, false);
  },
);

test(
  "a workspace stage starts in the project, reads it and still cannot write it",
  { skip: !sandboxAvailable("readonly_agent") },
  (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-stage-workspace-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = resolve(root, "stage-home");
    const project = resolve(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(resolve(project, "README.md"), "project content");
    const executable = stageSandboxExecutable(process.execPath, home, {
      readRoots: [project],
      workdir: project,
    });
    const script = `const fs=require("fs");console.log(fs.readFileSync("README.md","utf8"));try{fs.writeFileSync("README.md","changed");process.exit(9)}catch(e){if(!["EPERM","EACCES","EROFS","ENOENT"].includes(e.code))throw e;}`;
    const output = execFileSync(executable, ["-e", script], {
      cwd: root,
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.match(output, /project content/);
    assert.equal(
      readFileSync(resolve(project, "README.md"), "utf8"),
      "project content",
    );
    mkdirSync(resolve(root, "other-home"));
    assert.throws(
      () =>
        stageSandboxExecutable(process.execPath, resolve(root, "other-home"), {
          workdir: project,
        }),
      /stage_workdir_not_readable/,
    );
  },
);

test("digest handles numeric keys, HTML characters and Unicode separators", () => {
  const value = {
    10: "ten",
    2: "two",
    script: "a < b && x > 0",
    unicode: "你好\u2028分隔\u2029结束",
  };
  assert.equal(
    digestObject(value),
    digestBytes(
      '{"10":"ten","2":"two","script":"a < b && x > 0","unicode":"你好\\u2028分隔\\u2029结束"}',
    ),
  );
});

test("a Codex stage session loads no native skills, so a candidate cannot plant one for its judge", () => {
  for (const [instructions, directory] of [
    [false, true],
    [true, true],
    [false, false],
  ]) {
    const { toml, overrides } = codexStageConfig(instructions, directory);
    assert.match(toml, /\[skills\]\ninclude_instructions = false\n/);
    assert.match(toml, /\[skills\.bundled\]\nenabled = false\n/);
    assert.deepEqual(overrides.skills, {
      include_instructions: false,
      bundled: { enabled: false },
    });
    assert.deepEqual(overrides.mcp_servers, {});
    assert.equal(overrides.project_doc_max_bytes, instructions ? 32768 : 0);
  }
});
