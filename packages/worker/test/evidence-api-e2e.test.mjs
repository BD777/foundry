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
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "../dist/issue-environments.js";
import { evidenceWorkerAction } from "../dist/evidence-rpc.js";
import { stopEvidenceHTTPServices } from "../dist/evidence-http-service.js";
import { git, gitCommit } from "../dist/execution-git.js";
import { loginTestOwner, pairTestDevice } from "../scripts/server-session.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, matches, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await delay(50);
  }
  throw new Error("Evidence end-to-end timed out");
}

test(
  "real Server HTTP + Worker: fixed API evidence, dropped receipt recovery, exact Accept",
  {
    skip: process.platform !== "darwin",
    timeout: process.env.FOUNDRY_VERIFY_E2E_LIVE === "1" ? 300000 : 90000,
  },
  async (t) => {
    const liveAgent = process.env.FOUNDRY_VERIFY_E2E_LIVE === "1";
    const root = mkdtempSync(resolve(tmpdir(), "foundry-evidence-api-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = resolve(root, "server");
    execFileSync("go", ["build", "-o", executable, "./cmd/foundry-server"], {
      cwd: new URL("../../../apps/server/", import.meta.url),
      stdio: "pipe",
    });
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(executable, [], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        FOUNDRY_HOST: "127.0.0.1",
        FOUNDRY_DB_PATH: resolve(root, "test.db"),
        FOUNDRY_DEMO_SEED: "0",
      },
      stdio: "pipe",
    });
    let serverLog = "";
    server.stdout.on("data", (chunk) => {
      serverLog += chunk;
    });
    server.stderr.on("data", (chunk) => {
      serverLog += chunk;
    });
    t.after(async () => {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await once(server, "exit");
      }
    });
    await until(async () => {
      try {
        return (await fetch(`${base}/healthz`)).ok;
      } catch {
        return false;
      }
    }, Boolean);
    const session = {
      executable,
      env: { ...process.env, FOUNDRY_DB_PATH: resolve(root, "test.db") },
      base,
    };
    const auth = {
      ...(await loginTestOwner({
        ...session,
        origin: "http://127.0.0.1:31983",
      })),
      ...(await pairTestDevice({ ...session, deviceId: "dev_api_e2e" })),
    };
    const api = async (path, body, key = randomUUID()) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      assert.ok(
        response.ok,
        `${path}: ${response.status} ${text}\n${serverLog}`,
      );
      return text ? JSON.parse(text) : undefined;
    };
    const source = resolve(root, "source");
    mkdirSync(source);
    await git(source, ["init", "-b", "main"]);
    writeFileSync(
      resolve(source, "handler.mjs"),
      "export default (req,res)=>res.end('old');",
    );
    await git(source, ["add", "."]);
    await gitCommit(source, "baseline");
    const execution = new ExecutionStore(resolve(root, "state"));
    const workspaceId = "ws_api_e2e",
      deviceId = "dev_api_e2e";
    const registration = {
      device: {
        id: deviceId,
        label: "Synthetic evidence Worker",
        status: "connected",
      },
      workspace: {
        id: workspaceId,
        name: "Evidence test",
        localPath: source,
        baseline: "main",
      },
      providerHealth: [],
      assets: [],
      agents: [],
      agentProfiles: [],
      workspaceFiles: [],
    };
    let socket,
      dropNextCollection = true,
      collectionCount = 0,
      implementationError;
    const attach = async () => {
      socket = new WebSocket(base.replace("http", "ws") + "/api/daemon/ws", {
        headers: auth,
      });
      const connection = socket;
      connection.on("message", async (bytes) => {
        const message = JSON.parse(bytes.toString());
        const send = (type, payload) =>
          connection.send(JSON.stringify({ type, payload, id: message.id }));
        try {
          if (message.type === "run_issue") {
            const issue = message.payload.issue;
            const runId = `run_${randomUUID()}`;
            await api(`/api/daemon/issues/${issue.id}/runs`, {
              run: {
                id: runId,
                issueId: issue.id,
                runtime: issue.runtime,
                events: [],
              },
            });
            let environment = await prepareIssueEnvironment(
              source,
              workspaceId,
              issue.id,
              execution,
            );
            writeFileSync(
              resolve(environment.cwd, "handler.mjs"),
              `export default (req,res)=>{const value=new URL(req.url,"http://localhost").searchParams.get("value");res.writeHead(value?200:400,{"Content-Type":"application/json"});res.end(JSON.stringify({valid:!!value}));};`,
            );
            if (liveAgent)
              writeFileSync(
                resolve(environment.cwd, "API.md"),
                "# Goal\nReject empty input.\n# Outcome\nNon-empty value returns 200; empty value returns 400.\n",
              );
            environment = await snapshotEnvironment(environment, execution);
            environment.contractRevision = issue.currentContractRevision;
            environment.controlIsolationVersion = 1;
            environment.controlServerURL = base;
            execution.saveEnvironment(environment);
            await api(`/api/daemon/issues/${issue.id}/complete`, {
              runId,
              response: "Synthetic implementation ready",
              environmentId: environment.id,
              environmentRevision: environment.revision,
              checks: [],
              artifact: {
                id: `art_${randomUUID()}`,
                issueId: issue.id,
                title: "Summary",
                kind: "text",
              },
            });
          } else if (message.type === "evidence_request") {
            if (message.payload.action === "collect") collectionCount++;
            const result = await evidenceWorkerAction(
              message.payload,
              execution,
            );
            if (message.payload.action === "collect" && dropNextCollection) {
              dropNextCollection = false;
              connection.close();
              return; // Intentionally lose a durable result, not its execution.
            }
            send("evidence_result", result);
          }
        } catch (error) {
          if (
            message.type === "evidence_request" &&
            connection.readyState === WebSocket.OPEN
          )
            send("evidence_result", {
              taskId: message.payload.taskId,
              error: String(error),
            });
          else implementationError = error;
        }
      });
      await once(connection, "open");
      connection.send(JSON.stringify({ type: "hello", payload: registration }));
      await until(
        () => api("/api/workspaces"),
        (items) => items.some((w) => w.id === workspaceId),
      );
    };
    await attach();
    t.after(() => socket?.terminate());
    const issue = await api("/api/issues", {
      workspaceId,
      sourceInput: "Fix API input validation",
      runtime: "claude",
    });
    t.after(() => stopEvidenceHTTPServices(issue.id));
    assert.equal(issue.contractState, "draft");
    await delay(100);
    assert.equal((await api(`/api/issues/${issue.id}`)).run, undefined);
    let baseRevision = 1;
    if (liveAgent) {
      const initial = (await api(`/api/issues/${issue.id}/contracts`)).items[0];
      const clarified = await api(`/api/issues/${issue.id}/clarify`, {
        expectedRevision: initial.revision,
        expectedContentDigest: initial.contentDigest,
        message:
          "Please ask me the most important unanswered question before proposing criteria. Do not propose a contract yet.",
        changeReason: "Clarify expected API behavior",
      });
      assert.equal(clarified.currentContractRevision, undefined);
      assert.equal(clarified.run, undefined);
      assert.equal(
        clarified.messages.filter((m) => m.id.startsWith("clarify_")).length,
        2,
      );
      baseRevision = clarified.draftContractRevision;
    }
    const criteria = [
      ["valid", "/?value=hello", 200, true],
      ["invalid", "/", 400, false],
    ].map(([id, path, expectedStatus, valid]) => ({
      id,
      title: id,
      statement: `Return ${expectedStatus} for ${id} input`,
      required: true,
      proofKind: "functional",
      evaluationMode: "deterministic",
      rubric: {
        text: "Compare actual HTTP status and JSON validity",
        media: [],
      },
      evidenceRequirements: [
        {
          id: "exchange",
          description: "Actual request and response",
          acceptedCarriers: ["http_exchange"],
          minimumCount: 1,
          bindingPolicy: "system_observed",
        },
      ],
      checker: {
        id: `check_${id}`,
        version: 1,
        description: "HTTP assertions",
        timeoutMs: 5000,
        definitionDigest: `sha256:${"0".repeat(64)}`,
        configuration: {
          kind: "http",
          targetName: "api",
          method: "GET",
          path,
          headers: {},
          secretBindings: [],
          expectedStatus,
          expectedHeaders: { "content-type": "application/json" },
          expectedJsonValues: { "/valid": valid },
        },
      },
    }));
    if (liveAgent)
      criteria.push({
        id: "document",
        title: "Complete API documentation",
        statement:
          "Documentation includes Goal and Outcome and correctly describes valid 200 and invalid 400 responses.",
        required: true,
        proofKind: "content_completeness",
        evaluationMode: "agent",
        rubric: {
          text: "Read the exported document. Section headings Goal and Outcome and both status codes must be present.",
          media: [],
        },
        evidenceRequirements: [
          {
            id: "document",
            description: "Full candidate API.md",
            acceptedCarriers: ["document"],
            minimumCount: 1,
            bindingPolicy: "system_observed",
          },
        ],
      });
    const contract = await api(`/api/issues/${issue.id}/contracts`, {
      baseRevision,
      changeReason: "Specify actual validation outcomes",
      content: {
        goal: { text: "Fix API validation", media: [] },
        inScope: [],
        outOfScope: [],
        constraints: [],
        criteria,
      },
    });
    await api(
      `/api/issues/${issue.id}/contracts/${contract.revision}/confirm`,
      { expectedContentDigest: contract.contentDigest },
    );
    await until(
      async () => {
        if (implementationError) throw implementationError;
        return api(`/api/issues/${issue.id}`);
      },
      (i) => i.status === "verifying",
    );
    let sealed = await api(`/api/issues/${issue.id}/candidate-snapshots`, {
      expectedContractRevision: contract.revision,
      httpTargets: [{ name: "api", entrypointRelativePath: "handler.mjs" }],
    });
    if (liveAgent)
      await api(`/api/issues/${issue.id}/evidence/export`, {
        expectedContractRevision: contract.revision,
        verificationInputId: sealed.input.id,
        repoId: sealed.candidate.repositories[0].repoId,
        relativePath: "API.md",
        carrier: "document",
        claims: [
          {
            criterionId: "document",
            requirementId: "document",
            purpose: "Read complete documentation",
          },
        ],
      });
    for (const criterion of criteria) {
      const response = await api(`/api/issues/${issue.id}/verify`, {
        expectedContractRevision: contract.revision,
        expectedCandidateSnapshotId: sealed.candidate.id,
        criterionIds: [criterion.id],
      });
      if (criterion.id === "valid") {
        await until(
          async () => socket.readyState,
          (state) => state === WebSocket.CLOSED,
        );
        await attach();
      }
      const v = await until(
        () =>
          api(`/api/issues/${issue.id}/verifications/${response.items[0].id}`),
        (v) => ["completed", "failed", "canceled"].includes(v.status),
        liveAgent ? 210000 : 45000,
      );
      assert.equal(v.status, "completed", JSON.stringify(v));
      assert.equal(v.result.verdict, "pass");
      if (criterion.id === "document") {
        await api(`/api/issues/${issue.id}/human-assessments`, {
          verificationId: v.id,
          verdict: "pass",
          rationale: {
            text: "Both headings and both documented HTTP status codes are present in the cited candidate file.",
            media: [],
          },
          evidenceCitations: v.result.findings.flatMap(
            (f) => f.evidenceCitations,
          ),
        });
        t.diagnostic(
          `Real isolated Agent preliminary judgment: ${v.result.verdict}; session ${v.executor.sessionId}`,
        );
      }
    }
    assert.equal(
      collectionCount,
      2,
      "lost receipt recovery replayed a collection",
    );
    let review = await api(`/api/issues/${issue.id}/review`);
    assert.equal(review.eligible, true, JSON.stringify(review));
    if (!liveAgent) {
      const oldReview = review;
      writeFileSync(resolve(source, "external.txt"), "other accepted work");
      await git(source, ["add", "."]);
      await gitCommit(source, "baseline advanced");
      const stale = await api(`/api/issues/${issue.id}/review`);
      assert.equal(stale.eligible, false);
      assert.ok(
        stale.blockingReasons.some((b) => b.code === "baseline_changed"),
      );
      const alignmentKey = randomUUID();
      const alignment = {
        expectedContractRevision: contract.revision,
        alignFromSnapshotId: sealed.candidate.id,
        httpTargets: [{ name: "api", entrypointRelativePath: "handler.mjs" }],
      };
      sealed = await api(
        `/api/issues/${issue.id}/candidate-snapshots`,
        alignment,
        alignmentKey,
      );
      const replayed = await api(
        `/api/issues/${issue.id}/candidate-snapshots`,
        alignment,
        alignmentKey,
      );
      assert.equal(replayed.candidate.id, sealed.candidate.id);
      assert.equal(
        sealed.candidate.parentSnapshotId,
        alignment.alignFromSnapshotId,
      );
      review = await api(`/api/issues/${issue.id}/review`);
      assert.equal(review.eligible, false, "alignment reused old judgments");
      for (const criterion of criteria) {
        const result = await api(`/api/issues/${issue.id}/verify`, {
          expectedContractRevision: contract.revision,
          expectedCandidateSnapshotId: sealed.candidate.id,
          criterionIds: [criterion.id],
        });
        const v = await until(
          () =>
            api(`/api/issues/${issue.id}/verifications/${result.items[0].id}`),
          (v) => ["completed", "failed"].includes(v.status),
        );
        assert.equal(v.result?.verdict, "pass", JSON.stringify(v));
      }
      review = await api(`/api/issues/${issue.id}/review`);
      assert.equal(review.eligible, true, JSON.stringify(review));
      assert.notEqual(
        review.candidateSnapshotId,
        oldReview.candidateSnapshotId,
      );
      const rejected = await fetch(`${base}/api/issues/${issue.id}/accept`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          reviewSnapshotId: oldReview.id,
          reviewDigest: oldReview.digest,
        }),
      });
      assert.equal(
        rejected.status,
        409,
        "old baseline approval remained usable",
      );
    }
    const key = randomUUID();
    const decision = {
      reviewSnapshotId: review.id,
      reviewDigest: review.digest,
    };
    assert.equal(
      (await api(`/api/issues/${issue.id}/accept`, decision, key)).status,
      "accepted",
    );
    assert.equal(
      (await api(`/api/issues/${issue.id}/accept`, decision, key)).status,
      "accepted",
    );
    assert.match(readFileSync(resolve(source, "handler.mjs"), "utf8"), /400/);
    const evidence = await api(`/api/issues/${issue.id}/evidence`);
    assert.equal(evidence.items.length, liveAgent ? 3 : 4);
    assert.equal(
      evidence.items.filter((e) => e.source.kind === "tool_capture").length,
      liveAgent ? 2 : 4,
    );
  },
);
