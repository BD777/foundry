import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EvidenceStore, digestObject } from "../dist/evidence-store.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  collectCommand,
  collectHTTP,
  captureProcess,
} from "../dist/evidence-collectors.js";
import { verifierPacket } from "../dist/evidence-agent.js";
import { executeIssue } from "../dist/issue-execution.js";
import { createServer } from "node:http";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const execution = new ExecutionStore(root);
  const store = new EvidenceStore(
    "ws_test",
    "iss_test",
    "device",
    { kind: "daemon", id: "device", displayName: "Worker" },
    execution,
  );
  return { root, store, execution };
}
test("sealed materials survive scratch deletion and detect corruption", (t) => {
  const { store, root } = fixture(t);
  const m = store.sealMaterial(
    "report",
    "document",
    Buffer.from("observed output"),
  );
  assert.equal(statSync(store.materialPath(m.id)).mode & 0o777, 0o600);
  const scratch = resolve(root, "scratch");
  mkdirSync(scratch);
  rmSync(scratch, { recursive: true });
  assert.equal(store.readMaterial(m.id).toString(), "observed output");
  writeFileSync(store.materialPath(m.id), "modified");
  assert.equal(store.getMaterial(m.id).availability, "corrupt");
  assert.throws(() => store.readMaterial(m.id), /corrupt/);
  assert.throws(() => store.readMaterial("../escape"), /identifier/);
});
test("material ownership rejects another issue and active content is not HTML", (t) => {
  const { store, execution } = fixture(t);
  const material = store.sealMaterial(
    "page.html",
    "document",
    Buffer.from("<script>alert(1)</script>"),
  );
  assert.equal(material.mimeType, "text/plain");
  const other = new EvidenceStore(
    "ws_test",
    "iss_other",
    "device",
    store.actor,
    execution,
  );
  assert.throws(() => other.readMaterial(material.id), /cross_issue/);
});
test("command collection distinguishes pass, fail, zero assertions, bad format, timeout", async (t) => {
  const { store, root } = fixture(t);
  const bundle = store.sealMaterial(
    "checker",
    "data",
    Buffer.from(JSON.stringify({ files: { "check.js": "// frozen check" } })),
  );
  const config = {
    kind: "command",
    executable: "node",
    args: [],
    cwdRelativePath: ".",
    checkerBundleMaterialId: bundle.id,
    entrypoint: "check.js",
    fixtureMaterialIds: [],
    environment: {},
    secretBindings: [],
    expectedExitCodes: [0],
    resultFormat: "foundry-check/v1",
    minimumAssertions: 1,
  };
  const checker = {
    id: "check",
    version: 1,
    description: "HTTP validation",
    configuration: config,
    timeoutMs: 1000,
    definitionDigest: digestObject({
      configuration: config,
      bundleDigest: bundle.digest,
      fixtureDigests: [],
      timeoutMs: 1000,
    }),
  };
  const cases = [
    {
      text: JSON.stringify({
        assertions: [
          { id: "one", expected: 200, observed: 200, verdict: "pass" },
        ],
      }),
      verdict: "pass",
    },
    {
      text: JSON.stringify({
        assertions: [
          { id: "one", expected: 400, observed: 200, verdict: "fail" },
        ],
      }),
      verdict: "fail",
    },
    { text: '{"assertions":[]}', error: "insufficient_assertions" },
    { text: "done!", error: "invalid_report" },
    { text: "", outcome: "timed_out", error: "timed_out" },
  ];
  for (const [index, c] of cases.entries()) {
    const result = await collectCommand({
      checker,
      input: { id: "input" },
      claims: [
        {
          criterionId: "api",
          requirementId: "requests",
          purpose: "legal and illegal inputs",
        },
      ],
      candidateDirectory: root,
      outputDirectory: resolve(root, `output-${index}`),
      store,
      launch: async () => ({
        stdout: Buffer.from(c.text),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        outcome: c.outcome ?? "completed",
        complete: true,
      }),
    });
    assert.equal(result.verdict, c.verdict);
    assert.equal(result.technicalError?.code, c.error);
    assert.equal("verdict" in result.evidence, false);
    assert.equal(
      store.readMaterial(result.evidence.collection.inputMaterialId).length > 0,
      true,
    );
  }
});
test("process wrapper records actual exit and timeout", async () => {
  const completed = await captureProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('actual');process.exit(3)"],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
  });
  assert.equal(completed.exitCode, 3);
  assert.equal(completed.stdout.toString(), "actual");
  const timeout = await captureProcess({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    timeoutMs: 30,
  });
  assert.equal(timeout.outcome, "timed_out");
});
test("HTTP 200 from an unbound instance is rejected before networking", async (t) => {
  const { store } = fixture(t);
  let authorized = false;
  await assert.rejects(
    collectHTTP({
      checker: {
        configuration: {
          kind: "http",
          targetName: "api",
          secretBindings: [],
          headers: {},
        },
      },
      input: {
        id: "i",
        candidateSnapshotId: "snap",
        targets: [{ name: "api", bindingStatus: "unknown" }],
      },
      claims: [],
      targetURL: "http://127.0.0.1:1",
      store,
      authorize: async () => {
        authorized = true;
      },
    }),
    /input_unbound/,
  );
  assert.equal(authorized, false);
});
test("Agent packet carries actual image bytes separately from reference roles", (t) => {
  const { store } = fixture(t);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const image = store.sealMaterial("target", "image", bytes);
  const document = store.sealMaterial(
    "actual",
    "document",
    Buffer.from("actual candidate"),
  );
  const contract = {
    issueId: "iss_test",
    workspaceId: "ws_test",
    goal: {
      text: "Review",
      media: [{ materialId: image.id, role: "target", caption: "target" }],
    },
  };
  const criterion = { rubric: { text: "Match target", media: [] } };
  const evidence = [
    {
      id: "e",
      issueId: "iss_test",
      workspaceId: "ws_test",
      verificationInputId: "i",
      materials: [{ materialId: document.id, role: "primary" }],
    },
  ];
  const packet = verifierPacket(
    contract,
    criterion,
    { id: "i" },
    evidence,
    store,
  );
  assert.deepEqual(packet.images[0].bytes, bytes);
  assert.match(packet.prompt, /actual candidate/);
  assert.match(packet.prompt, /References are targets, not observations/);
  assert.throws(
    () => verifierPacket(contract, criterion, { id: "wrong" }, evidence, store),
    /cross_input/,
  );
});
test("worker rejects unconfirmed issue before touching its workspace", async () => {
  await assert.rejects(
    executeIssue(
      "http://invalid",
      "/nonexistent",
      { contractState: "draft" },
      {},
    ),
    /confirmation_required/,
  );
  for (const runtime of ["mock", "claude", "codex"]) {
    await assert.rejects(
      executeIssue(
        "http://invalid",
        "/nonexistent",
        {
          runtime,
          contractState: "confirmed",
          currentContractRevision: 1,
        },
        {},
      ),
      /confirmed_execution_contract_required/,
    );
  }
});
test("HTTP collector persists real success and assertion failure without following redirect", async (t) => {
  const { store } = fixture(t);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "/ok");
      res.end("{}");
      return;
    }
    res.statusCode = req.url === "/ok" ? 200 : 400;
    res.end(JSON.stringify({ valid: req.url === "/ok" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  for (const [path, status, valid, verdict] of [
    ["/ok", 200, true, "pass"],
    ["/bad", 400, false, "pass"],
    ["/bad", 200, true, "fail"],
    ["/redirect", 200, true, "fail"],
  ]) {
    const result = await collectHTTP({
      store,
      targetURL: `http://127.0.0.1:${port}`,
      checker: {
        id: "http",
        definitionDigest: digestObject({
          configuration: {
            kind: "http",
            targetName: "api",
            path,
            method: "GET",
            headers: {},
            secretBindings: [],
            expectedStatus: status,
            expectedHeaders: { "content-type": "application/json" },
            expectedJsonValues: { "/valid": valid },
          },
          bodyDigest: "",
          timeoutMs: 1000,
        }),
        description: "Validate requests",
        timeoutMs: 1000,
        configuration: {
          kind: "http",
          targetName: "api",
          path,
          method: "GET",
          headers: {},
          secretBindings: [],
          expectedStatus: status,
          expectedHeaders: { "content-type": "application/json" },
          expectedJsonValues: { "/valid": valid },
        },
      },
      input: {
        id: "input",
        candidateSnapshotId: "snap",
        targets: [
          {
            name: "api",
            bindingStatus: "verified",
            build: { sourceCandidateSnapshotId: "snap" },
          },
        ],
      },
      claims: [
        { criterionId: "c", requirementId: "r", purpose: "Validate response" },
      ],
      authorize: async (method) => assert.equal(method, "GET"),
    });
    assert.equal(result.verdict, verdict);
    assert.equal(result.evidence.collection.outcome, "completed");
    assert.ok(result.evidence.collection.httpStatus);
  }
  assert.equal(requests, 4, "redirect must not be followed");
});
