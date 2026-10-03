import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { crc32 } from "node:zlib";

const home = realpathSync(mkdtempSync(join(tmpdir(), "foundry-go-deps-")));
process.env.HOME = home;
process.env.FOUNDRY_STATE_ROOT = join(home, ".foundry");
mkdirSync(join(home, ".foundry"));
// Go keeps its module cache read-only.
test.after(() => {
  execFileSync("chmod", ["-R", "u+w", home]);
  rmSync(home, { recursive: true, force: true });
});

const { git, gitCommit } = await import("../dist/execution-git.js");
const { prepareIssueEnvironment, snapshotEnvironment } =
  await import("../dist/issue-environments.js");
const { ExecutionStore } = await import("../dist/execution-storage.js");
const { EvidenceStore, digestObject } =
  await import("../dist/evidence-store.js");
const { evidenceWorkerAction } = await import("../dist/evidence-rpc.js");
const { sandboxAvailable } = await import("../dist/sandbox/index.js");

const goRoot = (() => {
  try {
    return execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();
const skip = !goRoot || !sandboxAvailable("offline_command");

/** A zip with stored entries, as Go module zips may be. */
function storedZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const path = Buffer.from(name);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** A module only a local file proxy serves, and a cache warmed from it. */
function offlineModule() {
  const proxy = resolve(home, "go-proxy/example.com/greet/@v");
  if (!existsSync(proxy)) {
    mkdirSync(proxy, { recursive: true });
    const mod = "module example.com/greet\n\ngo 1.21\n";
    writeFileSync(resolve(proxy, "list"), "v1.0.0\n");
    writeFileSync(
      resolve(proxy, "v1.0.0.info"),
      JSON.stringify({ Version: "v1.0.0", Time: "2026-01-01T00:00:00Z" }),
    );
    writeFileSync(resolve(proxy, "v1.0.0.mod"), mod);
    writeFileSync(
      resolve(proxy, "v1.0.0.zip"),
      storedZip({
        "example.com/greet@v1.0.0/go.mod": mod,
        "example.com/greet@v1.0.0/greet.go":
          'package greet\n\nfunc Hello() string { return "offline module" }\n',
      }),
    );
  }
  return `file://${resolve(home, "go-proxy")}`;
}

async function fixture(t, cache) {
  const root = realpathSync(mkdtempSync(join(home, "issue-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const module = resolve(source, "apps/x");
  mkdirSync(module, { recursive: true });
  await git(source, ["init", "-b", "main"]);
  writeFileSync(
    resolve(module, "go.mod"),
    "module example.com/x\n\ngo 1.21\n\nrequire example.com/greet v1.0.0\n",
  );
  writeFileSync(
    resolve(module, "main.go"),
    'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/greet"\n)\n\nfunc main() { fmt.Println(greet.Hello()) }\n',
  );
  // Warm a scratch module cache from the file proxy and write go.sum.
  execFileSync("go", ["mod", "tidy"], {
    cwd: module,
    stdio: "ignore",
    env: {
      ...process.env,
      GOMODCACHE: resolve(home, "go-mod-cache"),
      GOPROXY: offlineModule(),
      GOSUMDB: "off",
      GOFLAGS: "-mod=mod",
      GOTOOLCHAIN: "local",
    },
  });
  process.env.GOMODCACHE = cache;
  await git(source, ["add", "."]);
  await gitCommit(source, "baseline");
  const execution = new ExecutionStore(resolve(root, "state"));
  let environment = await prepareIssueEnvironment(
    source,
    "ws_go",
    "iss_go",
    execution,
  );
  environment = await snapshotEnvironment(environment, execution);
  environment.controlIsolationVersion = 1;
  environment.contractRevision = 1;
  execution.saveEnvironment(environment);
  const store = new EvidenceStore(
    "ws_go",
    "iss_go",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  const configuration = {
    kind: "project_command",
    executable: resolve(goRoot, "bin", "go"),
    // Into the check's copy, which accepts new files on every platform.
    args: ["build", "-o", "built-x", "."],
    cwdRelativePath: "apps/x",
    environment: {},
    expectedExitCodes: [0],
  };
  const criterion = {
    id: "builds",
    title: "Builds with its modules",
    statement: "apps/x builds with its modules",
    required: true,
    proofKind: "functional",
    evaluationMode: "deterministic",
    rubric: { text: "go build", media: [] },
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
      id: "builds",
      version: 1,
      description: "go build",
      timeoutMs: 300000,
      configuration,
      definitionDigest: digestObject({ configuration, timeoutMs: 300000 }),
    },
  };
  const contract = {
    ...store.record("contract"),
    revision: 1,
    origin: "user",
    goal: { text: "Builds", media: [] },
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
  const scope = { workspaceId: "ws_go", issueId: "iss_go", deviceId: "dev" };
  const seal = () =>
    evidenceWorkerAction(
      { ...scope, action: "seal", taskId: "seal", contract },
      execution,
    );
  const collect = async (sealed) => {
    const verification = {
      ...store.record("verify"),
      sequence: 1,
      criterionId: "builds",
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
    return evidenceWorkerAction(
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
  };
  return { seal, collect, store };
}

test(
  "a Go module's go.sum is recorded and its modules come from the device's cache",
  { skip },
  async (t) => {
    const { seal, collect, store } = await fixture(
      t,
      resolve(home, "go-mod-cache"),
    );
    const sealed = await seal();
    assert.equal(sealed.error, undefined, sealed.error);
    const manifest = JSON.parse(
      store.readMaterial(sealed.candidate.fileManifestMaterialId).toString(),
    );
    const sum = manifest.find((f) => f.path === "apps/x/go.sum");
    assert.equal(sealed.input.dependencies.length, 1);
    assert.equal(sealed.input.dependencies[0].name, "apps/x/go.sum");
    assert.equal(sealed.input.dependencies[0].versionToken, sum.digest);
    assert.match(sealed.input.dependencies[0].sourceLabel, /GOPROXY=off/);
    assert.ok(
      sealed.input.environment.tools.some((tool) => tool.name === "go"),
    );
    const result = await collect(sealed);
    assert.equal(
      result.verification.status,
      "completed",
      JSON.stringify(result.verification),
    );
    assert.equal(result.verification.result.verdict, "pass");
  },
);

test(
  "Go modules missing from this device's cache are a clear technical failure",
  { skip },
  async (t) => {
    const empty = resolve(home, "empty-go-cache");
    mkdirSync(empty, { recursive: true });
    const { seal, collect } = await fixture(t, empty);
    const result = await collect(await seal());
    assert.equal(result.verification.status, "failed");
    assert.equal(result.verification.error.code, "dependencies_unavailable");
    assert.match(
      result.verification.error.message,
      /not all in this device's module cache/,
    );
  },
);
