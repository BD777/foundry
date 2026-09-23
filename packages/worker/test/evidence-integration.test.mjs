import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { git, gitCommit } from "../dist/execution-git.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "../dist/issue-environments.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import { EvidenceStore, digestObject } from "../dist/evidence-store.js";
import {
  sealCandidate,
  assertSnapshotCurrent,
  materializeCandidate,
} from "../dist/evidence-snapshots.js";
import { acceptEvidenceCandidate } from "../dist/evidence-acceptance.js";
import {
  sandboxCommand,
  executorEnvironment,
} from "../dist/execution-sandbox.js";
import { evidenceWorkerAction } from "../dist/evidence-rpc.js";
import { stopEvidenceHTTPServices } from "../dist/evidence-http-service.js";
import { createServer } from "node:http";
import { ensureRepository } from "../dist/issue-environments.js";
import { prepareAcceptance } from "../dist/workspace-acceptance.js";
import { refreshCandidate } from "../dist/candidate-refresh.js";
import { writeJSON } from "../dist/storage.js";

async function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-evidence-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  mkdirSync(source);
  await git(source, ["init", "-b", "main"]);
  writeFileSync(
    resolve(source, "api.js"),
    "export const validate = x => typeof x === 'string';\n",
  );
  await git(source, ["add", "."]);
  await gitCommit(source, "baseline");
  const execution = new ExecutionStore(resolve(root, "state"));
  let environment = await prepareIssueEnvironment(
    source,
    "ws_verify",
    "iss_verify",
    execution,
  );
  writeFileSync(
    resolve(environment.cwd, "api.js"),
    "export const validate = x => typeof x === 'string' && x.length > 0;\n",
  );
  writeFileSync(
    resolve(environment.cwd, "untracked.bin"),
    Buffer.from([0, 1, 255, 2]),
  );
  environment = await snapshotEnvironment(environment, execution);
  environment.controlIsolationVersion = 1;
  environment.contractRevision = 1;
  execution.saveEnvironment(environment);
  const store = new EvidenceStore(
    "ws_verify",
    "iss_verify",
    "dev",
    { kind: "daemon", id: "dev", displayName: "Worker" },
    execution,
  );
  return { root, source, execution, environment, store };
}
test("snapshot captures binary/untracked and excludes later evidence; dirty candidate is stale", async (t) => {
  const { root, environment, store } = await fixture(t);
  const snap = await sealCandidate(environment, store);
  const manifest = JSON.parse(
    store.readMaterial(snap.fileManifestMaterialId).toString(),
  );
  assert.ok(manifest.some((f) => f.path === "untracked.bin"));
  const materialized = resolve(root, "verify");
  await materializeCandidate(snap, environment, store, materialized);
  assert.deepEqual(
    readFileSync(resolve(materialized, "untracked.bin")),
    Buffer.from([0, 1, 255, 2]),
  );
  store.sealMaterial("actual screenshot", "image", Buffer.from("screenshot"));
  const again = await sealCandidate(environment, store);
  assert.equal(again.contentDigest, snap.contentDigest);
  writeFileSync(
    resolve(environment.cwd, "new-file.txt"),
    "new untracked content",
  );
  await assert.rejects(
    assertSnapshotCurrent(snap, environment, store),
    /candidate_changed/,
  );
});
test("baseline movement refuses old approval without changing source", async (t) => {
  const { source, environment, store } = await fixture(t);
  const snap = await sealCandidate(environment, store);
  writeFileSync(resolve(source, "another.txt"), "external change");
  await git(source, ["add", "."]);
  await gitCommit(source, "external baseline");
  await assert.rejects(
    assertSnapshotCurrent(snap, environment, store),
    /baseline_changed/,
  );
  assert.match(
    readFileSync(resolve(source, "api.js"), "utf8"),
    /typeof x === 'string';/,
  );
});
test(
  "review-bound acceptance integrates exact tree and retains material",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { source, environment, store, execution } = await fixture(t);
    const candidate = await sealCandidate(environment, store);
    const record = store.record("review");
    const review = {
      ...record,
      contractRevision: 1,
      candidateSnapshotId: candidate.id,
      criterionResults: [],
      blockingReasons: [],
      eligible: true,
      digest: digestObject({ candidate: candidate.id }),
    };
    const decision = {
      ...store.record("decision"),
      createdBy: { kind: "local_owner", id: "owner", displayName: "Owner" },
      reviewSnapshotId: review.id,
      reviewDigest: review.digest,
      contractRevision: 1,
      candidateSnapshotId: candidate.id,
      status: "approved",
    };
    const request = {
      action: "accept",
      workspaceId: "ws_verify",
      issueId: "iss_verify",
      deviceId: "dev",
      taskId: decision.id,
      decision,
      review,
      candidate,
      materialIds: [candidate.fileManifestMaterialId],
    };
    const result = await acceptEvidenceCandidate(request, store, execution);
    assert.equal(result.status, "integrated");
    assert.match(
      readFileSync(resolve(source, "api.js"), "utf8"),
      /x.length > 0/,
    );
    assert.ok(store.readMaterial(candidate.fileManifestMaterialId).length);
    const replay = await acceptEvidenceCandidate(request, store, execution);
    assert.equal(replay.integrationId, result.integrationId);
    const preflight = await acceptEvidenceCandidate(
      {
        action: "check_accept",
        workspaceId: request.workspaceId,
        issueId: request.issueId,
        deviceId: "dev",
        taskId: "retry-preflight",
        candidate,
        materialIds: request.materialIds,
        decisionId: decision.id,
      },
      store,
      execution,
    );
    assert.equal(preflight.status, "checked");
  },
);
test(
  "evidence-bound multi-repository journal preserves partial application and resumes exact approval",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-evidence-partial-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "source");
    const child = resolve(source, "repos/api");
    for (const directory of [source, child]) {
      mkdirSync(directory, { recursive: true });
      await git(directory, ["init", "-b", "main"]);
      writeFileSync(resolve(directory, "code.txt"), "baseline");
      if (directory === source)
        writeFileSync(resolve(directory, ".gitignore"), "repos/\n");
      await git(directory, ["add", "."]);
      await gitCommit(directory, "baseline");
    }
    const execution = new ExecutionStore(resolve(root, "state"));
    let environment = await prepareIssueEnvironment(
      source,
      "ws_partial",
      "iss_partial",
      execution,
    );
    const nested = execution
      .registration("ws_partial")
      .repositories.find((r) => r.relativePath === "repos/api");
    assert.ok(nested);
    environment = await ensureRepository(
      "ws_partial",
      "iss_partial",
      nested.id,
      execution,
    );
    for (const repo of environment.repositories)
      writeFileSync(resolve(repo.worktreePath, "code.txt"), "candidate");
    environment = await snapshotEnvironment(environment, execution);
    environment.controlIsolationVersion = 1;
    environment.contractRevision = 1;
    execution.saveEnvironment(environment);
    const store = new EvidenceStore(
      "ws_partial",
      "iss_partial",
      "dev",
      { kind: "daemon", id: "dev", displayName: "Worker" },
      execution,
    );
    const candidate = await sealCandidate(environment, store);
    const review = {
      ...store.record("review"),
      contractRevision: 1,
      candidateSnapshotId: candidate.id,
      criterionResults: [],
      blockingReasons: [],
      eligible: true,
      digest: digestObject(candidate.id),
    };
    const decision = {
      ...store.record("decision"),
      createdBy: { kind: "local_owner", id: "owner", displayName: "Owner" },
      reviewSnapshotId: review.id,
      reviewDigest: review.digest,
      contractRevision: 1,
      candidateSnapshotId: candidate.id,
      status: "approved",
    };
    const journal = await prepareAcceptance(
      "ws_partial",
      "iss_partial",
      environment.revision,
      execution,
    );
    assert.equal(journal.status, "prepared", journal.error);
    const integration = {
      ...candidate,
      ...store.record("snap"),
      purpose: "integration",
      parentSnapshotId: candidate.id,
      repositories: candidate.repositories.map((r) => ({
        ...r,
        candidateCommit: journal.repositories.find((p) => p.repoId === r.repoId)
          .target,
      })),
    };
    store.sealRecord("candidate-snapshots", integration, "CandidateSnapshot");
    Object.assign(journal, {
      status: "applying",
      decisionId: decision.id,
      candidateSnapshotId: candidate.id,
      reviewSnapshotId: review.id,
      integrationSnapshotId: integration.id,
      finalVerificationIds: [],
    });
    const journalPath = resolve(
      environment.directory,
      "../../acceptances",
      journal.id,
      "acceptance.json",
    );
    writeJSON(journalPath, journal);
    environment.acceptanceId = journal.id;
    execution.saveEnvironment(environment);
    const [first, second] = journal.repositories;
    await git(first.sourcePath, ["merge", "--ff-only", first.target]);
    const externalDraft = resolve(second.sourcePath, "external-draft.txt");
    writeFileSync(externalDraft, "must not overwrite");
    const request = {
      action: "accept",
      workspaceId: "ws_partial",
      issueId: "iss_partial",
      deviceId: "dev",
      taskId: decision.id,
      decision,
      review,
      candidate,
      materialIds: [candidate.fileManifestMaterialId],
    };
    await assert.rejects(
      acceptEvidenceCandidate(request, store, execution),
      /uncommitted/,
    );
    assert.equal(JSON.parse(readFileSync(journalPath)).status, "applying");
    assert.equal(
      await git(first.sourcePath, ["rev-parse", "HEAD"]),
      first.target,
    );
    assert.equal(
      await git(second.sourcePath, ["rev-parse", "HEAD"]),
      second.expected,
    );
    assert.equal(readFileSync(externalDraft, "utf8"), "must not overwrite");
    await assert.rejects(
      refreshCandidate(environment, execution),
      /integration_recovery_required/,
    );
    rmSync(externalDraft); // Only this synthetic test's injected untracked file.
    const resumed = await acceptEvidenceCandidate(
      request,
      store,
      new ExecutionStore(execution.stateRoot),
    );
    assert.equal(resumed.status, "integrated");
    assert.equal(resumed.integrationId, journal.id);
    assert.equal(
      await git(second.sourcePath, ["rev-parse", "HEAD"]),
      second.target,
    );
  },
);
test(
  "executor cannot read unrelated control files or inherit control environment",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { root, environment, execution } = await fixture(t);
    const secret = resolve(root, "private-control-config");
    writeFileSync(secret, "private owner credential", { mode: 0o600 });
    const spec = sandboxCommand(
      environment,
      execution.registration("ws_verify"),
      process.execPath,
      ["-e", "require('node:fs').readFileSync(process.argv[1])", secret],
    );
    assert.throws(() =>
      execFileSync(spec.command, spec.args, {
        cwd: environment.cwd,
        env: executorEnvironment(environment),
        stdio: "pipe",
      }),
    );
    const previous = process.env.FOUNDRY_CONTROL_TOKEN;
    process.env.FOUNDRY_CONTROL_TOKEN = "test-secret";
    try {
      assert.equal(
        executorEnvironment(environment).FOUNDRY_CONTROL_TOKEN,
        undefined,
      );
    } finally {
      if (previous === undefined) delete process.env.FOUNDRY_CONTROL_TOKEN;
      else process.env.FOUNDRY_CONTROL_TOKEN = previous;
    }
  },
);
test(
  "trusted worker executes frozen checker and persists result across duplicate RPC",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { environment, store, execution } = await fixture(t);
    const bundle = store.sealMaterial(
      "checker bundle",
      "data",
      Buffer.from(
        JSON.stringify({
          files: {
            "check.cjs":
              "const fs=require('node:fs');const source=fs.readFileSync('api.js','utf8');console.log(JSON.stringify({assertions:[{id:'reject-empty',expected:true,observed:source.includes('x.length > 0'),verdict:source.includes('x.length > 0')?'pass':'fail'}]}));",
          },
        }),
      ),
    );
    const configuration = {
      kind: "command",
      executable: process.execPath,
      args: [],
      cwdRelativePath: ".",
      checkerBundleMaterialId: bundle.id,
      entrypoint: "check.cjs",
      fixtureMaterialIds: [],
      environment: {},
      secretBindings: [],
      expectedExitCodes: [0],
      resultFormat: "foundry-check/v1",
      minimumAssertions: 1,
    };
    const checker = {
      id: "checker",
      version: 1,
      description: "Empty values are rejected",
      timeoutMs: 5000,
      configuration,
      definitionDigest: digestObject({
        configuration,
        bundleDigest: bundle.digest,
        fixtureDigests: [],
        timeoutMs: 5000,
      }),
    };
    const contract = {
      ...store.record("contract"),
      revision: 1,
      origin: "user",
      goal: { text: "Validate empty API values", media: [] },
      inScope: [],
      outOfScope: [],
      constraints: [],
      criteria: [
        {
          id: "valid",
          title: "Reject empty values",
          statement: "API validates empty input",
          required: true,
          proofKind: "functional",
          evaluationMode: "deterministic",
          rubric: { text: "Reject empty strings", media: [] },
          evidenceRequirements: [
            {
              id: "capture",
              description: "Actual program assertions",
              acceptedCarriers: ["text_log"],
              minimumCount: 1,
              bindingPolicy: "system_observed",
            },
          ],
          checker,
        },
      ],
      contentDigest: digestObject({ goal: "validation" }),
      status: "confirmed",
    };
    contract.confirmation = {
      actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
      at: new Date().toISOString(),
      contentDigest: contract.contentDigest,
    };
    const scope = {
      workspaceId: environment.workspaceId,
      issueId: environment.issueId,
      deviceId: "dev",
    };
    const sealed = await evidenceWorkerAction(
      { ...scope, action: "seal", taskId: "seal-test", contract },
      execution,
    );
    assert.equal(sealed.error, undefined, sealed.error);
    const verification = {
      ...store.record("verify"),
      sequence: 1,
      criterionId: "valid",
      contractRevision: 1,
      verificationInputId: sealed.input.id,
      evidenceIds: [store.record("ev").id],
      mode: "deterministic",
      executor: {
        kind: "program",
        name: "foundry-check",
        version: "1",
        checkerDigest: checker.definitionDigest,
      },
      status: "queued",
    };
    const request = {
      ...scope,
      action: "collect",
      taskId: verification.id,
      contract,
      verification,
      input: sealed.input,
    };
    const result = await evidenceWorkerAction(request, execution);
    assert.equal(result.error, undefined, result.error);
    assert.equal(
      result.verification.status,
      "completed",
      JSON.stringify({
        verification: result.verification,
        outputs: result.evidence?.flatMap((e) =>
          e.materials.map((m) => store.readMaterial(m.materialId).toString()),
        ),
      }),
    );
    assert.equal(result.verification.result.verdict, "pass");
    assert.equal(result.evidence[0].collection.exitCode, 0);
    assert.equal(result.evidence[0].id, verification.evidenceIds[0]);
    assert.deepEqual(await evidenceWorkerAction(request, execution), result);
    const recovered = await evidenceWorkerAction(
      { ...scope, action: "recover", taskId: verification.id },
      new ExecutionStore(execution.stateRoot),
    );
    assert.equal(recovered.status, "settled");
    assert.deepEqual(recovered.recovered, result);
    await assert.rejects(
      evidenceWorkerAction(
        {
          ...scope,
          issueId: "iss_other",
          action: "recover",
          taskId: verification.id,
        },
        execution,
      ),
      /recovery_scope_mismatch/,
    );
  },
);

test(
  "the project's own command decides the verdict and its output becomes the evidence",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { environment, store, execution } = await fixture(t);
    const commandCriterion = (id, script, description) => {
      const configuration = {
        kind: "project_command",
        executable: process.execPath,
        args: ["-e", script],
        cwdRelativePath: ".",
        environment: {},
        expectedExitCodes: [0],
      };
      return {
        id,
        title: description,
        statement: description,
        required: true,
        proofKind: "functional",
        evaluationMode: "deterministic",
        rubric: { text: description, media: [] },
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
          id,
          version: 1,
          description,
          timeoutMs: 15000,
          configuration,
          definitionDigest: digestObject({ configuration, timeoutMs: 15000 }),
        },
      };
    };
    // Both commands read the candidate the same way; only the outcome differs.
    const read = "const s=require('node:fs').readFileSync('api.js','utf8');";
    const contract = {
      ...store.record("contract"),
      revision: 1,
      origin: "user",
      goal: { text: "Empty values are rejected", media: [] },
      inScope: [],
      outOfScope: [],
      constraints: [],
      criteria: [
        commandCriterion(
          "passing",
          `${read}console.log('checked length guard');process.exit(s.includes('x.length > 0')?0:1);`,
          "The candidate rejects empty values",
        ),
        commandCriterion(
          "failing",
          `${read}console.log('checked missing guard');process.exit(s.includes('never present')?0:1);`,
          "A condition the candidate does not satisfy",
        ),
      ],
      contentDigest: digestObject({ goal: "project command" }),
      status: "confirmed",
    };
    contract.confirmation = {
      actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
      at: new Date().toISOString(),
      contentDigest: contract.contentDigest,
    };
    const scope = {
      workspaceId: environment.workspaceId,
      issueId: environment.issueId,
      deviceId: "dev",
    };
    const sealed = await evidenceWorkerAction(
      { ...scope, action: "seal", taskId: "seal-project-command", contract },
      execution,
    );
    assert.equal(sealed.error, undefined, sealed.error);
    const collect = async (criterionId) => {
      const verification = {
        ...store.record("verify"),
        sequence: 1,
        criterionId,
        contractRevision: 1,
        verificationInputId: sealed.input.id,
        evidenceIds: [store.record("ev").id],
        mode: "deterministic",
        executor: {
          kind: "program",
          name: "foundry-check",
          version: "1",
          checkerDigest: contract.criteria.find((c) => c.id === criterionId)
            .checker.definitionDigest,
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
    const passed = await collect("passing");
    assert.equal(passed.error, undefined, passed.error);
    assert.equal(
      passed.verification.status,
      "completed",
      JSON.stringify(passed.verification),
    );
    assert.equal(passed.verification.result.verdict, "pass");
    assert.equal(passed.evidence[0].collection.exitCode, 0);
    assert.equal(
      passed.evidence[0].collection.collectorName,
      "foundry-project-command",
    );
    assert.equal(passed.evidence[0].candidateBinding, "system_observed");
    const stdout = passed.evidence[0].materials.find(
      (m) => m.role === "stdout",
    );
    assert.match(
      store.readMaterial(stdout.materialId).toString(),
      /checked length guard/,
    );
    const failed = await collect("failing");
    assert.equal(failed.error, undefined, failed.error);
    assert.equal(failed.verification.result.verdict, "fail");
    assert.equal(failed.evidence[0].collection.exitCode, 1);
  },
);

test(
  "custom control port is inaccessible from executor",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { environment, execution } = await fixture(t);
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      res.end("control");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    environment.controlServerURL = `http://127.0.0.1:${server.address().port}`;
    const spec = sandboxCommand(
      environment,
      execution.registration("ws_verify"),
      process.execPath,
      [
        "-e",
        `fetch(${JSON.stringify(environment.controlServerURL)},{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(0)).catch(()=>process.exit(19))`,
      ],
    );
    assert.throws(
      () =>
        execFileSync(spec.command, spec.args, {
          cwd: environment.cwd,
          env: executorEnvironment(environment),
          stdio: "pipe",
        }),
      (error) => error.status === 19,
    );
    assert.equal(requests, 0);
  },
);

test(
  "HTTP verification binds managed candidate and exports candidate files",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { environment: original, execution, store } = await fixture(t);
    writeFileSync(
      resolve(original.cwd, "handler.mjs"),
      `export default (req,res)=>{const valid=new URL(req.url,"http://localhost").searchParams.get("value");res.writeHead(valid?200:400,{"Content-Type":"application/json"});res.end(JSON.stringify({valid:!!valid}));};`,
    );
    const environment = await snapshotEnvironment(original, execution);
    environment.controlIsolationVersion = 1;
    environment.contractRevision = 1;
    execution.saveEnvironment(environment);
    t.after(() => stopEvidenceHTTPServices(environment.issueId));
    const checkerFor = (name, path, status, valid) => {
      const configuration = {
        kind: "http",
        targetName: "api",
        method: "GET",
        path,
        headers: {},
        secretBindings: [],
        expectedStatus: status,
        expectedHeaders: { "content-type": "application/json" },
        expectedJsonValues: { "/valid": valid },
      };
      return {
        id: name,
        version: 1,
        description: name,
        timeoutMs: 5000,
        configuration,
        definitionDigest: digestObject({
          configuration,
          bodyDigest: "",
          timeoutMs: 5000,
        }),
      };
    };
    const criteria = [
      checkerFor("valid", "/?value=hello", 200, true),
      checkerFor("invalid", "/", 400, false),
    ].map((checker) => ({
      id: checker.id,
      title: checker.id,
      statement: "Validate actual API input",
      required: true,
      proofKind: "functional",
      evaluationMode: "deterministic",
      rubric: { text: "Valid 200, invalid 400", media: [] },
      evidenceRequirements: [
        {
          id: "exchange",
          description: "Actual request/response",
          acceptedCarriers: ["http_exchange"],
          minimumCount: 1,
          bindingPolicy: "system_observed",
        },
      ],
      checker,
    }));
    criteria.push({
      id: "document",
      title: "Document source",
      statement: "Source exports a handler",
      required: true,
      proofKind: "content_completeness",
      evaluationMode: "agent",
      rubric: { text: "Complete export", media: [] },
      evidenceRequirements: [
        {
          id: "source",
          description: "Handler",
          acceptedCarriers: ["document"],
          minimumCount: 1,
          bindingPolicy: "system_observed",
        },
      ],
    });
    criteria[2].evidenceRequirements.push({
      id: "changes",
      description: "System-observed changed files",
      acceptedCarriers: ["data"],
      minimumCount: 1,
      bindingPolicy: "system_observed",
    });
    const contract = {
      ...store.record("contract"),
      revision: 1,
      origin: "user",
      goal: { text: "Validate API", media: [] },
      inScope: [],
      outOfScope: [],
      constraints: [],
      criteria,
      contentDigest: digestObject(criteria),
      status: "confirmed",
    };
    contract.confirmation = {
      actor: { kind: "local_owner", id: "owner", displayName: "Owner" },
      at: new Date().toISOString(),
      contentDigest: contract.contentDigest,
    };
    const scope = {
      workspaceId: environment.workspaceId,
      issueId: environment.issueId,
      deviceId: "dev",
    };
    const sealed = await evidenceWorkerAction(
      {
        ...scope,
        action: "seal",
        taskId: "http-seal",
        contract,
        httpTargets: [{ name: "api", entrypointRelativePath: "handler.mjs" }],
      },
      execution,
    );
    assert.equal(sealed.error, undefined, sealed.error);
    assert.equal(
      sealed.input.targets[0].build.sourceCandidateSnapshotId,
      sealed.candidate.id,
    );
    for (const [sequence, criterion] of criteria.slice(0, 2).entries()) {
      const verification = {
        ...store.record("verify"),
        sequence: sequence + 1,
        criterionId: criterion.id,
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
          input: sealed.input,
          verification,
        },
        execution,
      );
      assert.equal(result.error, undefined, result.error);
      assert.equal(
        result.verification.result?.verdict,
        "pass",
        JSON.stringify(result.verification),
      );
      assert.equal(
        result.evidence[0].collection.httpStatus,
        criterion.checker.configuration.expectedStatus,
      );
    }
    const exported = await evidenceWorkerAction(
      {
        ...scope,
        action: "file_export",
        taskId: "export-test",
        contract,
        input: sealed.input,
        repoId: sealed.candidate.repositories[0].repoId,
        relativePath: "handler.mjs",
        carrier: "document",
        claims: [
          {
            criterionId: "document",
            requirementId: "source",
            purpose: "inspect",
          },
        ],
      },
      execution,
    );
    assert.equal(exported.error, undefined, exported.error);
    assert.equal(exported.evidence[0].source.kind, "candidate_export");
    assert.match(
      store
        .readMaterial(exported.evidence[0].materials[0].materialId)
        .toString(),
      /export default/,
    );
    const changeExportRequest = {
      ...scope,
      action: "file_export",
      sourceKind: "candidate_changes",
      taskId: "export-changes",
      contract,
      input: sealed.input,
      repoId: "",
      relativePath: "",
      carrier: "data",
      claims: [
        {
          criterionId: "document",
          requirementId: "changes",
          purpose: "check scope",
        },
      ],
    };
    const changes = await evidenceWorkerAction(changeExportRequest, execution);
    assert.equal(changes.error, undefined, changes.error);
    assert.equal(changes.evidence[0].candidateBinding, "system_observed");
    assert.equal(
      changes.evidence[0].collection.collectorName,
      "foundry-candidate-changes",
    );
    const manifest = JSON.parse(
      store
        .readMaterial(changes.evidence[0].materials[0].materialId)
        .toString(),
    );
    assert.equal(manifest.candidateSnapshotId, sealed.candidate.id);
    assert.deepEqual(
      manifest.repositories[0].changes.map((c) => c.path),
      ["api.js", "handler.mjs", "untracked.bin"],
    );
    const replay = await evidenceWorkerAction(changeExportRequest, execution);
    assert.equal(replay.evidence[0].id, changes.evidence[0].id);
    const invalid = await evidenceWorkerAction(
      {
        ...changeExportRequest,
        taskId: "bad-export-changes",
        relativePath: "agent-invented.txt",
      },
      execution,
    );
    assert.match(invalid.error, /without_file_path/);
    stopEvidenceHTTPServices(environment.issueId);
    const verification = {
      ...store.record("verify"),
      sequence: 3,
      criterionId: "valid",
      contractRevision: 1,
      verificationInputId: sealed.input.id,
      evidenceIds: [store.record("ev").id],
      mode: "deterministic",
      executor: {
        kind: "program",
        name: "foundry-check",
        version: "1",
        checkerDigest: criteria[0].checker.definitionDigest,
      },
      status: "queued",
    };
    const lost = await evidenceWorkerAction(
      {
        ...scope,
        action: "collect",
        taskId: verification.id,
        contract,
        input: sealed.input,
        verification,
      },
      execution,
    );
    assert.equal(lost.verification.status, "failed");
    assert.match(
      lost.verification.error.message,
      /target_instance_unavailable/,
    );
  },
);
