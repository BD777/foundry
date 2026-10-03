import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const home = realpathSync(mkdtempSync(join(tmpdir(), "foundry-deps-")));
process.env.HOME = home;
process.env.FOUNDRY_STATE_ROOT = join(home, ".foundry");
mkdirSync(join(home, ".foundry"));
test.after(() => rmSync(home, { recursive: true, force: true }));

const { git, gitCommit } = await import("../dist/execution-git.js");
const { prepareIssueEnvironment, snapshotEnvironment } =
  await import("../dist/issue-environments.js");
const { ExecutionStore } = await import("../dist/execution-storage.js");
const { EvidenceStore, digestObject } =
  await import("../dist/evidence-store.js");
const { evidenceWorkerAction } = await import("../dist/evidence-rpc.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");

/**
 * A package that only exists in a local npm cache: installing it offline
 * works when the cache is warm and cannot work otherwise.
 */
function offlinePackage() {
  const dir = resolve(home, "offline-dep");
  if (!tryRead(resolve(dir, "integrity"))) {
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(
      resolve(dir, "src/package.json"),
      JSON.stringify({
        name: "foundry-offline-dep",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(
      resolve(dir, "src/index.js"),
      'module.exports = "offline dep";\n',
    );
    const tarball = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", dir],
      { cwd: resolve(dir, "src"), encoding: "utf8" },
    ).trim();
    const bytes = readFileSync(resolve(dir, tarball));
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    execFileSync(
      "npm",
      ["cache", "add", resolve(dir, tarball), "--cache", resolve(dir, "cache")],
      { stdio: "ignore" },
    );
    writeFileSync(resolve(dir, "integrity"), integrity);
  }
  return {
    cache: resolve(dir, "cache"),
    integrity: readFileSync(resolve(dir, "integrity"), "utf8"),
  };
}
function tryRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function fixture(t, script) {
  const { integrity } = offlinePackage();
  const root = realpathSync(mkdtempSync(join(home, "issue-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  mkdirSync(source);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(resolve(source, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(
    resolve(source, "package.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      private: true,
      dependencies: { "foundry-offline-dep": "1.0.0" },
    }),
  );
  writeFileSync(
    resolve(source, "package-lock.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "proj",
          version: "1.0.0",
          dependencies: { "foundry-offline-dep": "1.0.0" },
        },
        "node_modules/foundry-offline-dep": {
          version: "1.0.0",
          resolved:
            "https://registry.npmjs.org/foundry-offline-dep/-/foundry-offline-dep-1.0.0.tgz",
          integrity,
        },
      },
    }),
  );
  await git(source, ["add", "."]);
  await gitCommit(source, "baseline");
  const execution = new ExecutionStore(resolve(root, "state"));
  let environment = await prepareIssueEnvironment(
    source,
    "ws_deps",
    "iss_deps",
    execution,
  );
  writeFileSync(resolve(environment.cwd, "check.js"), script);
  environment = await snapshotEnvironment(environment, execution);
  environment.controlIsolationVersion = 1;
  environment.contractRevision = 1;
  execution.saveEnvironment(environment);
  const store = new EvidenceStore(
    "ws_deps",
    "iss_deps",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  const configuration = {
    kind: "project_command",
    executable: process.execPath,
    args: ["check.js"],
    cwdRelativePath: ".",
    environment: {},
    expectedExitCodes: [0],
  };
  const criterion = {
    id: "runs",
    title: "Runs with its dependencies",
    statement: "check.js runs with its dependencies",
    required: true,
    proofKind: "functional",
    evaluationMode: "deterministic",
    rubric: { text: "Run check.js", media: [] },
    evidenceRequirements: [
      {
        id: "output",
        description: "Captured command output",
        acceptedCarriers: ["text_log"],
        minimumCount: 1,
        bindingPolicy: "system_observed",
      },
    ],
    checker: {
      id: "runs",
      version: 1,
      description: "Runs check.js",
      timeoutMs: 120000,
      configuration,
      definitionDigest: digestObject({ configuration, timeoutMs: 120000 }),
    },
  };
  const contract = {
    ...store.record("contract"),
    revision: 1,
    origin: "user",
    goal: { text: "Runs", media: [] },
    inScope: [],
    outOfScope: [],
    constraints: [],
    criteria: [criterion],
    contentDigest: digestObject([criterion]),
    status: "confirmed",
  };
  contract.confirmation = {
    actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
    at: new Date().toISOString(),
    contentDigest: contract.contentDigest,
  };
  const scope = {
    workspaceId: "ws_deps",
    issueId: "iss_deps",
    deviceId: "dev",
  };
  const seal = () =>
    evidenceWorkerAction(
      { ...scope, action: "seal", taskId: "seal", contract },
      execution,
    );
  const collect = async (sealed) => {
    const verification = {
      ...store.record("verify"),
      sequence: 1,
      criterionId: "runs",
      contractRevision: 1,
      verificationInputId: sealed.input.id,
      evidenceIds: [store.record("ev").id],
      mode: "deterministic",
      executor: {
        kind: "program",
        name: "foundry-check",
        version: "1",
        checkerDigest: criterion.checker.definitionDigest,
      },
      status: "queued",
    };
    const result = await evidenceWorkerAction(
      {
        ...scope,
        action: "collect",
        taskId: verification.id,
        contract,
        verification,
        input: sealed.input,
      },
      execution,
    );
    result.copy = resolve(
      store.root,
      "verifier-output",
      verification.id,
      "candidate",
    );
    return result;
  };
  return { seal, collect, store };
}

/** Uses the package, adds a build file, cannot change a tracked file, writes /tmp. */
const usesDependency = `
const fs = require("node:fs");
if (require("foundry-offline-dep") !== "offline dep") process.exit(2);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/out.txt", "built");
try { fs.appendFileSync("package.json", "x"); process.exit(3); } catch {}
fs.writeFileSync("/tmp/foundry-check", "x");
console.log("dependency ok");
`;

test("the sealed input records each tracked lockfile with its digest", async (t) => {
  process.env.npm_config_cache = offlinePackage().cache;
  const { seal, store } = await fixture(t, usesDependency);
  const sealed = await seal();
  assert.equal(sealed.error, undefined, sealed.error);
  const manifest = JSON.parse(
    store.readMaterial(sealed.candidate.fileManifestMaterialId).toString(),
  );
  const lock = manifest.find((f) => f.path === "package-lock.json");
  assert.deepEqual(sealed.input.dependencies, [
    {
      name: "package-lock.json",
      kind: "dependency_lock",
      sourceLabel: sealed.input.dependencies[0].sourceLabel,
      versionToken: lock.digest,
      revalidation: "immutable",
    },
  ]);
  assert.match(sealed.input.dependencies[0].sourceLabel, /^npm ci --offline/);
  assert.ok(sealed.input.environment.tools.some((tool) => tool.name === "npm"));
});

test(
  "a project command runs with dependencies installed offline from the lockfile",
  { skip: !sandboxAvailable("offline_command") },
  async (t) => {
    process.env.npm_config_cache = offlinePackage().cache;
    const { seal, collect, store } = await fixture(t, usesDependency);
    const result = await collect(await seal());
    assert.equal(
      result.verification.status,
      "completed",
      JSON.stringify(result.verification),
    );
    assert.equal(result.verification.result.verdict, "pass");
    const supporting = result.evidence[0].materials.find(
      (m) => m.role === "supporting",
    );
    assert.ok(supporting, "the install log is part of the evidence");
    assert.match(
      store.readMaterial(supporting.materialId).toString(),
      /npm ci --offline/,
    );
    assert.equal(
      existsSync(result.copy),
      false,
      "the check's copy and its node_modules are removed",
    );
  },
);

test(
  "dependencies missing from this device's cache are a clear technical failure",
  { skip: !sandboxAvailable("offline_command") },
  async (t) => {
    const empty = resolve(home, "empty-cache");
    mkdirSync(empty, { recursive: true });
    process.env.npm_config_cache = empty;
    const { seal, collect } = await fixture(t, usesDependency);
    const result = await collect(await seal());
    assert.equal(result.verification.status, "failed");
    assert.equal(result.verification.error.code, "dependencies_unavailable");
    assert.match(
      result.verification.error.message,
      /not available offline on this device\. Run npm ci once/,
    );
    assert.equal(result.materials.length, 1, "the install log is kept");
    assert.equal(existsSync(result.copy), false);
  },
);
