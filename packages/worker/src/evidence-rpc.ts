import { arch, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  EvidenceWorkerRequest,
  EvidenceWorkerResult,
  Material,
  VerificationInput,
  VerificationResult,
} from "@foundry/protocol";
import { validateEvidenceModel } from "@foundry/protocol";
import {
  EvidenceStore,
  digestBytes,
  digestObject,
  MATERIAL_LIMIT,
  atomicEvidenceFile,
} from "./evidence-store.js";
import { ExecutionStore, identifier } from "./execution-storage.js";
import {
  assertSnapshotCurrent,
  materializeCandidate,
  sealCandidate,
} from "./evidence-snapshots.js";
import {
  collectCommand,
  collectHTTP,
  collectProjectCommand,
} from "./evidence-collectors.js";
import {
  startEvidenceHTTPService,
  evidenceHTTPServiceURL,
  stopEvidenceHTTPServices,
} from "./evidence-http-service.js";
import { runEvidenceCommand } from "./evidence-command-sandbox.js";
import { judgeWithAgent } from "./evidence-agent.js";
import { git } from "./execution-git.js";
import { acceptEvidenceCandidate } from "./evidence-acceptance.js";
import { redactEvidence } from "./evidence-redaction.js";
import { clarifyIssueContract } from "./evidence-clarification.js";
import { candidateChangeManifest } from "./evidence-change-manifest.js";
import { refreshCandidate } from "./candidate-refresh.js";
import { snapshotEnvironment, assertMutable } from "./issue-environments.js";
import {
  appendEvidenceUpload,
  expireIncompleteUploads,
  finishEvidenceUpload,
} from "./evidence-uploads.js";

const activeEvidenceTasks = new Set<string>();

/** Durable request ledger prevents replay of commands after transport interruption. */
export async function evidenceWorkerAction(
  request: EvidenceWorkerRequest,
  execution = new ExecutionStore(),
  /** Local path of the selected workspace; the clarification stage works in it. */
  workspacePath?: string,
): Promise<EvidenceWorkerResult> {
  const store = new EvidenceStore(
    request.workspaceId,
    request.issueId,
    request.deviceId,
    { kind: "daemon", id: request.deviceId, displayName: "Foundry Worker" },
    execution,
  );
  const taskId = identifier(request.taskId);
  if (request.action === "recover") {
    const intentPath = resolve(store.root, "outbox", `${taskId}.intent.json`);
    if (!existsSync(intentPath)) return { taskId, status: "not_started" };
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    if (
      intent.issueId !== request.issueId ||
      intent.workspaceId !== request.workspaceId ||
      !["collect", "assess"].includes(intent.action)
    )
      throw new Error("recovery_scope_mismatch");
    const resultPath = resolve(store.root, "outbox", `${taskId}.result.json`);
    if (existsSync(resultPath))
      return {
        taskId,
        status: "settled",
        recovered: JSON.parse(readFileSync(resultPath, "utf8")),
      };
    return {
      taskId,
      status: activeEvidenceTasks.has(intentPath) ? "running" : "unknown",
    };
  }
  if (request.action === "check_accept" || request.action === "accept")
    return acceptEvidenceCandidate(request, store, execution);
  if (request.action === "read") {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0)
      throw new Error("invalid_chunk_offset");
    const bytes = store.readMaterial(request.materialId);
    return {
      taskId,
      bytesBase64: bytes
        .subarray(request.offset, request.offset + 256 * 1024)
        .toString("base64"),
      byteSize: bytes.length,
    };
  }
  if (request.action === "inventory") {
    const offset = request.offset ?? 0,
      limit = request.limit ?? 100;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("invalid_inventory_page");
    const materials = store
      .listRecords<Material>("materials")
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      taskId,
      total: materials.length,
      materials: materials
        .slice(offset, offset + limit)
        .map((m) => store.getMaterial(m.id)),
    };
  }
  return execution.lock(
    request.workspaceId,
    `evidence-${request.issueId}`,
    async () => {
      const ledger = resolve(store.root, "outbox", `${taskId}.result.json`);
      const intent = resolve(store.root, "outbox", `${taskId}.intent.json`);
      if (request.action === "upload_chunk") {
        expireIncompleteUploads(store);
        appendEvidenceUpload(
          store,
          taskId,
          request.offset,
          request.bytesBase64,
        );
        return { taskId };
      }
      const digest = digestObject(request);
      if (existsSync(intent)) {
        if (JSON.parse(readFileSync(intent, "utf8")).digest !== digest)
          throw new Error("idempotency_conflict");
        if (existsSync(ledger)) return JSON.parse(readFileSync(ledger, "utf8"));
        throw new Error(
          "task_outcome_unknown: inspect retained output; do not replay external actions",
        );
      }
      atomicEvidenceFile(
        intent,
        JSON.stringify({
          digest,
          requestId: taskId,
          issueId: request.issueId,
          workspaceId: request.workspaceId,
          action: request.action,
          startedAt: new Date().toISOString(),
        }),
      );
      let result: EvidenceWorkerResult;
      activeEvidenceTasks.add(intent);
      try {
        const needsCandidate = [
          "seal",
          "collect",
          "assess",
          "file_export",
        ].includes(request.action);
        result = needsCandidate
          ? await execution.lock(
              request.workspaceId,
              `execution-${request.issueId}`,
              () => execute(request, store, execution, workspacePath),
            )
          : await execute(request, store, execution, workspacePath);
      } catch (error) {
        result = { taskId, error: String(error) };
      } finally {
        activeEvidenceTasks.delete(intent);
      }
      atomicEvidenceFile(ledger, JSON.stringify(result));
      if (request.action === "upload_seal" && !result.error)
        finishEvidenceUpload(store, taskId);
      return result;
    },
  );
}

async function execute(
  request: EvidenceWorkerRequest,
  store: EvidenceStore,
  execution: ExecutionStore,
  workspacePath?: string,
): Promise<EvidenceWorkerResult> {
  const taskId = request.taskId;
  if (request.action === "clarify") {
    const source =
      workspacePath ?? execution.registration(request.workspaceId)?.sourcePath;
    if (!source) throw new Error("clarification_requires_local_workspace");
    return clarifyIssueContract(request, store, source);
  }
  if (request.action === "upload_seal") {
    if (request.actor.kind !== "user" && request.actor.kind !== "local_owner")
      throw new Error("human_upload_required");
    const path = resolve(store.root, "outbox", `${identifier(taskId)}.upload`);
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    if (bytes.length !== request.byteSize || bytes.length > MATERIAL_LIMIT)
      throw new Error("upload_size_mismatch");
    const material = store.sealMaterial(request.name, request.carrier, bytes);
    return { taskId, materials: [material] };
  }
  if (
    request.action !== "seal" &&
    request.action !== "collect" &&
    request.action !== "assess" &&
    request.action !== "file_export"
  )
    throw new Error("unsupported_evidence_action");
  if (
    validateEvidenceModel("IssueContract", request.contract).length ||
    request.contract.issueId !== request.issueId ||
    request.contract.workspaceId !== request.workspaceId ||
    request.contract.status !== "confirmed" ||
    request.contract.confirmation?.contentDigest !==
      request.contract.contentDigest
  )
    throw new Error("contract_confirmation_required");
  let environment = execution.environment(request.workspaceId, request.issueId);
  if (!environment) throw new Error("candidate_missing");
  if (
    environment.contractRevision !== request.contract.revision ||
    environment.controlIsolationVersion !== 1
  )
    throw new Error("candidate_requires_confirmed_isolated_execution");
  if (request.action === "seal") {
    if (request.alignFromSnapshotId) {
      assertMutable(environment);
      const before = store.readRecord<
        import("@foundry/protocol").CandidateSnapshot
      >("candidate-snapshots", request.alignFromSnapshotId);
      await assertSnapshotCurrent(before, environment, store, false);
      environment = await refreshCandidate(environment, execution);
      environment = await snapshotEnvironment(environment, execution);
    }
    const candidate = await sealCandidate(
      environment,
      store,
      request.alignFromSnapshotId,
    );
    const record = store.record("input");
    const bindingNotes: string[] = [];
    for (const repo of environment.repositories) {
      if (
        await git(repo.worktreePath, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
        ])
      )
        bindingNotes.push(
          `${repo.repoId}: ignored files exist; explicitly register any verification-affecting dependencies`,
        );
    }
    const targets: import("@foundry/protocol").TargetSnapshot[] = [];
    if (request.httpTargets?.length) {
      if (
        request.httpTargets.length > 10 ||
        new Set(request.httpTargets.map((t) => t.name)).size !==
          request.httpTargets.length
      )
        throw new Error("invalid_http_targets");
      stopEvidenceHTTPServices(request.issueId);
      const serviceRoot = resolve(
        store.root,
        "verifier-output",
        identifier(taskId),
      );
      const materialized = resolve(serviceRoot, "candidate");
      await materializeCandidate(candidate, environment, store, materialized);
      for (const [index, definition] of request.httpTargets.entries()) {
        if (
          !request.contract.criteria.some(
            (c) =>
              c.checker?.configuration.kind === "http" &&
              c.checker.configuration.targetName === definition.name,
          )
        )
          throw new Error("target_not_in_confirmed_contract");
        const target = await startEvidenceHTTPService(
          definition,
          candidate,
          materialized,
          resolve(serviceRoot, `service-${index}`),
        );
        target.build!.producerDeviceId = store.deviceId;
        targets.push(target);
      }
    }
    const core = {
      contractRevision: request.contract.revision,
      contractDigest: request.contract.contentDigest,
      candidateSnapshotId: candidate.id,
      candidateDigest: candidate.contentDigest,
      environment: {
        deviceId: store.deviceId,
        executionEnvironmentId: environment.id,
        os: platform(),
        architecture: arch(),
        tools: [{ name: "node", version: process.version }],
        configurationDigest: digestObject({}),
      },
      dependencies: [],
      targets,
      bindingStatus: bindingNotes.length
        ? ("unknown" as const)
        : ("verified" as const),
      bindingNotes,
    };
    const input: VerificationInput = {
      ...record,
      ...core,
      inputDigest: digestObject(core),
    };
    store.sealRecord("verification-inputs", input, "VerificationInput");
    return {
      taskId,
      candidate,
      input,
      materials: [store.getMaterial(candidate.fileManifestMaterialId)],
    };
  }
  if (request.action === "file_export") {
    if (
      request.sourceKind &&
      !["candidate_file", "candidate_changes"].includes(request.sourceKind)
    )
      throw new Error("unsupported_export_source");
    const changes = request.sourceKind === "candidate_changes";
    if (
      changes &&
      (request.carrier !== "data" || request.repoId || request.relativePath)
    )
      throw new Error("candidate_changes_requires_data_without_file_path");
    const input = store.readRecord<VerificationInput>(
      "verification-inputs",
      request.input.id,
    );
    if (
      input.inputDigest !== request.input.inputDigest ||
      input.contractDigest !== request.contract.contentDigest
    )
      throw new Error("input_changed");
    const snapshot = store.readRecord<
      import("@foundry/protocol").CandidateSnapshot
    >("candidate-snapshots", input.candidateSnapshotId);
    await assertSnapshotCurrent(snapshot, environment, store, false);
    const manifest = JSON.parse(
      store.readMaterial(snapshot.fileManifestMaterialId).toString(),
    ) as import("@foundry/protocol").SnapshotFile[];
    const file = manifest.find(
      (f) => f.repoId === request.repoId && f.path === request.relativePath,
    );
    const repo = environment.repositories.find(
      (r) => r.repoId === request.repoId,
    );
    const frozen = snapshot.repositories.find(
      (r) => r.repoId === request.repoId,
    );
    if (!changes && (!file || !repo || !frozen || file.kind !== "file"))
      throw new Error("export_requires_snapshot_file");
    for (const claim of request.claims) {
      const criterion = request.contract.criteria.find(
        (c) => c.id === claim.criterionId,
      );
      if (
        !criterion?.evidenceRequirements.some(
          (r) =>
            r.id === claim.requirementId &&
            r.acceptedCarriers.includes(request.carrier),
        )
      )
        throw new Error("invalid_export_claim");
    }
    const result = changes
      ? { stdout: await candidateChangeManifest(snapshot, environment) }
      : await promisify(execFile)(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            repo!.worktreePath,
            "show",
            `${frozen!.candidateCommit}:${file!.path}`,
          ],
          { encoding: "buffer", maxBuffer: MATERIAL_LIMIT },
        );
    if (!changes && digestBytes(result.stdout) !== file!.digest)
      throw new Error("snapshot_blob_corrupt");
    const safe = redactEvidence(result.stdout);
    const material = store.sealMaterial(
      changes ? "Candidate changes.json" : file!.path,
      request.carrier,
      safe.bytes,
      safe.redaction,
    );
    const parameters = store.sealMaterial(
      "Candidate export parameters",
      "data",
      Buffer.from(
        JSON.stringify({
          snapshotId: snapshot.id,
          sourceKind: changes ? "candidate_changes" : "candidate_file",
          repoId: repo?.repoId,
          relativePath: file?.path,
        }),
      ),
    );
    const now = new Date().toISOString();
    const evidence: import("@foundry/protocol").Evidence = {
      ...store.record("ev"),
      title: changes ? "系统生成的候选变更清单" : file!.path,
      description: changes
        ? "Git-observed changes between frozen baselines and candidate commits"
        : "File exported from the sealed candidate",
      verificationInputId: input.id,
      claims: request.claims,
      materials: [{ materialId: material.id, role: "primary" }],
      source: {
        kind: "candidate_export",
        producer: store.actor,
        deviceId: store.deviceId,
      },
      collection: {
        operation: "file_export",
        collectorName: changes
          ? "foundry-candidate-changes"
          : "foundry-candidate-export",
        collectorVersion: "1",
        inputMaterialId: parameters.id,
        startedAt: now,
        finishedAt: now,
        outcome: "completed",
        completeness: "complete",
      },
      candidateBinding: "system_observed",
    };
    store.sealRecord("evidence", evidence, "Evidence");
    return { taskId, materials: [parameters, material], evidence: [evidence] };
  }
  const verification = { ...request.verification };
  const input = store.readRecord<VerificationInput>(
    "verification-inputs",
    request.input.id,
  );
  if (
    input.inputDigest !== request.input.inputDigest ||
    input.contractDigest !== request.contract.contentDigest ||
    verification.verificationInputId !== input.id
  )
    throw new Error("verification_input_mismatch");
  const candidate = store.readRecord<
    import("@foundry/protocol").CandidateSnapshot
  >("candidate-snapshots", input.candidateSnapshotId);
  await assertSnapshotCurrent(candidate, environment, store, false);
  const criterion = request.contract.criteria.find(
    (c) => c.id === verification.criterionId,
  );
  if (!criterion) throw new Error("unknown_criterion");
  verification.status = "running";
  verification.startedAt = new Date().toISOString();
  const directory = resolve(store.root, "verifier-output", identifier(taskId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if (criterion.evaluationMode === "agent") {
      const evidence =
        request.action === "assess"
          ? request.evidence
          : verification.evidenceIds.map((id) =>
              store.readRecord<import("@foundry/protocol").Evidence>(
                "evidence",
                id,
              ),
            );
      if (
        evidence.length !== verification.evidenceIds.length ||
        evidence.some((e) => !verification.evidenceIds.includes(e.id))
      )
        throw new Error("fixed_evidence_set_mismatch");
      const judged = await judgeWithAgent({
        contract: request.contract,
        criterion,
        input,
        verification,
        evidence,
        store,
        directory,
        controlServerURL: environment.controlServerURL,
        // Verification happens on the implementation worktree itself, at the
        // sealed candidate version, with read-only access to it.
        workspace: {
          path: environment.cwd,
          readRoots: [
            environment.sourcePath,
            ...environment.repositories.map((repo) => repo.worktreePath),
          ],
        },
      });
      // The candidate must be exactly what was sealed, before and after.
      await assertSnapshotCurrent(candidate, environment, store, false);
      verification.result = judged.result;
      verification.status = "completed";
      verification.finishedAt = new Date().toISOString();
      if (verification.executor.kind === "agent")
        verification.executor = {
          ...verification.executor,
          reportedModel: judged.reportedModel,
          sessionId: judged.sessionId ?? verification.executor.sessionId,
          promptDigest: judged.promptDigest,
        };
      store.sealRecord("verifier-output", verification, "Verification");
      return {
        taskId,
        verification,
        materials: [
          store.getMaterial(judged.result.rawOutputMaterialId),
          store.getMaterial(judged.result.reportMaterialId),
        ],
      };
    }
    if (criterion.evaluationMode !== "deterministic" || !criterion.checker)
      throw new Error(
        "verifier_unavailable: an isolated agent adapter is required",
      );
    const candidateDirectory = resolve(directory, "candidate"),
      outputDirectory = resolve(directory, "output");
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    await materializeCandidate(
      candidate,
      environment,
      store,
      candidateDirectory,
    );
    const claims = criterion.evidenceRequirements.map((r) => ({
      criterionId: criterion.id,
      requirementId: r.id,
      purpose: r.description,
    }));
    if (verification.evidenceIds.length !== 1)
      throw new Error("reserved_collection_required");
    const evidenceId = identifier(verification.evidenceIds[0]!);
    const configuration = criterion.checker.configuration;
    const target =
      configuration.kind === "http"
        ? input.targets.find((t) => t.name === configuration.targetName)
        : undefined;
    const capture =
      configuration.kind === "http"
        ? await collectHTTP({
            evidenceId,
            checker: criterion.checker,
            input,
            claims,
            store,
            targetURL: target ? evidenceHTTPServiceURL(target, candidate) : "",
            authorize: async (method, url) => {
              if (
                !["GET", "HEAD"].includes(method.toUpperCase()) ||
                url.hostname !== "127.0.0.1"
              )
                throw new Error(
                  "http_operation_authorization_required: v1 managed targets only allow GET/HEAD",
                );
            },
          })
        : configuration.kind === "project_command"
          ? await collectProjectCommand({
              evidenceId,
              checker: criterion.checker,
              input,
              claims,
              candidateDirectory,
              outputDirectory,
              store,
              launch: (invocation) =>
                runEvidenceCommand(
                  invocation,
                  candidateDirectory,
                  outputDirectory,
                ),
            })
          : await collectCommand({
              evidenceId,
              checker: criterion.checker,
              input,
              claims,
              candidateDirectory,
              outputDirectory,
              store,
              launch: (invocation) =>
                runEvidenceCommand(
                  invocation,
                  candidateDirectory,
                  outputDirectory,
                ),
            });
    if (capture.technicalError) {
      verification.status = "failed";
      verification.error = capture.technicalError;
    } else {
      const raw = store.sealMaterial(
        "Program judgment",
        "data",
        Buffer.from(JSON.stringify({ assertions: capture.assertions })),
      );
      const summary =
        configuration.kind === "project_command"
          ? `系统运行 ${[configuration.executable, ...configuration.args].join(" ")}，退出码 ${capture.evidence.collection.exitCode ?? "未知"}`
          : `Fixed checker ${capture.verdict}`;
      const findings = (capture.assertions ?? []).map((a) => ({
        id: a.id,
        statement: criterion.statement,
        expected: JSON.stringify(a.expected),
        observed: JSON.stringify(a.observed),
        verdict: a.verdict,
        evidenceCitations: capture.evidence.materials
          .filter((m) => m.role === "stdout" || m.role === "response")
          .map((m) => ({
            evidenceId: capture.evidence.id,
            materialId: m.materialId,
          })),
        referenceCitations: [],
      }));
      const report = store.sealMaterial(
        "Verification report",
        "document",
        Buffer.from(
          [
            summary,
            criterion.statement,
            ...findings.map(
              (f) =>
                `${f.id}: expected ${f.expected}; observed ${f.observed}; ${f.verdict}`,
            ),
          ].join("\n"),
        ),
      );
      const result: VerificationResult = {
        verdict: capture.verdict!,
        summary,
        reasoning:
          "Fixed assertions evaluated against sealed candidate inputs.",
        findings,
        limitations: [],
        unmetRequirementIds: [],
        rawOutputMaterialId: raw.id,
        reportMaterialId: report.id,
        completedAt: new Date().toISOString(),
      };
      verification.result = result;
      verification.status = "completed";
      capture.materials.push(raw, report);
    }
    if (capture.evidence.id !== evidenceId)
      throw new Error("reserved_collection_mismatch");
    verification.finishedAt = new Date().toISOString();
    store.sealRecord("verifier-output", verification, "Verification");
    return {
      taskId,
      verification,
      evidence: [capture.evidence],
      materials: capture.materials,
    };
  } catch (error) {
    verification.status = "failed";
    verification.error = {
      code: "verification_error",
      message: String(error),
      retryable: false,
    };
    verification.finishedAt = new Date().toISOString();
    store.sealRecord("verifier-output", verification, "Verification");
    return { taskId, verification };
  }
}
