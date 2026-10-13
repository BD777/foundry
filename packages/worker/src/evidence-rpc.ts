import { arch, platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AcceptanceCriterion,
  CandidateSnapshot,
  CheckDefinition,
  Evidence,
  EvidenceWorkerRequest,
  EvidenceWorkerResult,
  InputDependency,
  Material,
  SnapshotFile,
  TargetSnapshot,
  Verification,
  VerificationInput,
  VerificationResult,
} from "@bd777/foundry-protocol";
import { validateEvidenceModel } from "@bd777/foundry-protocol";
import {
  EvidenceStore,
  digestBytes,
  digestObject,
  MATERIAL_LIMIT,
  atomicEvidenceFile,
} from "./evidence-store.js";
import { gitBytes } from "./execution-git.js";
import { ExecutionStore, identifier } from "./execution-storage.js";
import type { IssueEnvironment } from "./execution-types.js";
import {
  assertSnapshotCurrent,
  materializeCandidate,
  writeCandidateChanges,
  sealCandidate,
} from "./evidence-snapshots.js";
import {
  collectCommand,
  collectHTTP,
  collectProjectCommand,
  type CollectionResult,
  type CommandInvocation,
} from "./evidence-collectors.js";
import {
  startEvidenceHTTPService,
  evidenceHTTPServiceURL,
  stopEvidenceHTTPServices,
} from "./evidence-http-service.js";
import { runEvidenceCommand } from "./evidence-command-sandbox.js";
import {
  dependencyLocks,
  dependencyTooling,
  inputDependency,
  prepareDependencies,
  type DependencySandbox,
} from "./evidence-dependencies.js";
import { judgeWithAgent } from "./evidence-agent.js";
import { materializeSessionSkills } from "./skill-materializer.js";
import { acceptEvidenceCandidate } from "./evidence-acceptance.js";
import { redactEvidence } from "./evidence-redaction.js";
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
              () => execute(request, store, execution),
            )
          : await execute(request, store, execution);
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

type UploadSealRequest = Extract<
  EvidenceWorkerRequest,
  { action: "upload_seal" }
>;
type CandidateRequest = Extract<
  EvidenceWorkerRequest,
  { action: "seal" | "collect" | "assess" | "file_export" }
>;
type SealRequest = Extract<CandidateRequest, { action: "seal" }>;
type FileExportRequest = Extract<CandidateRequest, { action: "file_export" }>;
type VerifyRequest = Extract<
  CandidateRequest,
  { action: "collect" | "assess" }
>;

async function execute(
  request: EvidenceWorkerRequest,
  store: EvidenceStore,
  execution: ExecutionStore,
): Promise<EvidenceWorkerResult> {
  if (request.action === "upload_seal") return sealUpload(request, store);
  if (
    request.action !== "seal" &&
    request.action !== "collect" &&
    request.action !== "assess" &&
    request.action !== "file_export"
  )
    throw new Error("unsupported_evidence_action");
  const environment = requireConfirmedCandidate(request, execution);
  if (request.action === "seal")
    return sealVerificationInput(request, store, execution, environment);
  if (request.action === "file_export")
    return exportCandidateFile(request, store, environment);
  return verifyCriterion(request, store, environment);
}

function sealUpload(
  request: UploadSealRequest,
  store: EvidenceStore,
): EvidenceWorkerResult {
  if (request.actor.kind !== "user" && request.actor.kind !== "local_owner")
    throw new Error("human_upload_required");
  const path = resolve(
    store.root,
    "outbox",
    `${identifier(request.taskId)}.upload`,
  );
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  if (bytes.length !== request.byteSize || bytes.length > MATERIAL_LIMIT)
    throw new Error("upload_size_mismatch");
  const material = store.sealMaterial(request.name, request.carrier, bytes);
  return { taskId: request.taskId, materials: [material] };
}

/**
 * The Issue's candidate, only under the confirmed contract it was prepared
 * for and in the isolated execution that contract requires.
 */
function requireConfirmedCandidate(
  request: CandidateRequest,
  execution: ExecutionStore,
): IssueEnvironment {
  if (
    validateEvidenceModel("IssueContract", request.contract).length ||
    request.contract.issueId !== request.issueId ||
    request.contract.workspaceId !== request.workspaceId ||
    request.contract.status !== "confirmed" ||
    request.contract.confirmation?.contentDigest !==
      request.contract.contentDigest
  )
    throw new Error("contract_confirmation_required");
  const environment = execution.environment(
    request.workspaceId,
    request.issueId,
  );
  if (!environment) throw new Error("candidate_missing");
  if (
    environment.contractRevision !== request.contract.revision ||
    environment.controlIsolationVersion !== 1
  )
    throw new Error("candidate_requires_confirmed_isolated_execution");
  return environment;
}

async function sealVerificationInput(
  request: SealRequest,
  store: EvidenceStore,
  execution: ExecutionStore,
  confirmed: IssueEnvironment,
): Promise<EvidenceWorkerResult> {
  const environment = request.alignFromSnapshotId
    ? await alignCandidate(
        request.alignFromSnapshotId,
        confirmed,
        store,
        execution,
      )
    : confirmed;
  const candidate = await sealCandidate(
    environment,
    store,
    request.alignFromSnapshotId,
  );
  const record = store.record("input");
  // Checks, targets and judges all work on copies of the sealed candidate,
  // so the live worktree's ignored files (node_modules, dist, .env) are not
  // an input of this verification.
  const bindingNotes: string[] = [];
  const targets = await startHTTPTargets(
    request,
    store,
    candidate,
    environment,
  );
  const { tools, dependencies } = await candidateDependencies(
    candidate,
    environment,
    store,
    request.taskId,
  );
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
      tools,
      configurationDigest: digestObject({}),
    },
    dependencies,
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
    taskId: request.taskId,
    candidate,
    input,
    materials: [store.getMaterial(candidate.fileManifestMaterialId)],
  };
}

/** The candidate brought up to date from the snapshot it was sealed as. */
async function alignCandidate(
  snapshotId: string,
  environment: IssueEnvironment,
  store: EvidenceStore,
  execution: ExecutionStore,
): Promise<IssueEnvironment> {
  assertMutable(environment);
  const before = store.readRecord<CandidateSnapshot>(
    "candidate-snapshots",
    snapshotId,
  );
  await assertSnapshotCurrent(before, environment, store, false);
  const refreshed = await refreshCandidate(environment, execution);
  // A conflict is resolved by the Issue's execution in the candidate,
  // then the candidate is prepared and checked again.
  if (refreshed.conflicts?.length)
    throw new Error(`alignment_conflict: ${refreshed.conflicts.join("; ")}`);
  return snapshotEnvironment(refreshed, execution);
}

/** The contract's HTTP targets, each served from a copy of the candidate. */
async function startHTTPTargets(
  request: SealRequest,
  store: EvidenceStore,
  candidate: CandidateSnapshot,
  environment: IssueEnvironment,
): Promise<TargetSnapshot[]> {
  const targets: TargetSnapshot[] = [];
  if (!request.httpTargets?.length) return targets;
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
    identifier(request.taskId),
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
  return targets;
}

/** Lockfiles the checks install from, offline, before a project command. */
async function candidateDependencies(
  candidate: CandidateSnapshot,
  environment: IssueEnvironment,
  store: EvidenceStore,
  taskId: string,
): Promise<{
  tools: { name: string; version: string }[];
  dependencies: InputDependency[];
}> {
  const tools = [{ name: "node", version: process.version }];
  const dependencies: InputDependency[] = [];
  for (const lock of dependencyLocks(candidate, store)) {
    const repo = environment.repositories.find(
      (r) => r.relativePath === lock.repoRelativePath,
    );
    const tooling = repo
      ? await dependencyTooling(
          lock,
          repo.worktreePath,
          resolve(store.root, "verifier-output", identifier(taskId), "tooling"),
        )
      : undefined;
    if (tooling && !tools.some((t) => t.name === lock.manager))
      tools.push({ name: lock.manager, version: tooling.version });
    dependencies.push(inputDependency(lock, tooling?.version));
  }
  return { tools, dependencies };
}

async function exportCandidateFile(
  request: FileExportRequest,
  store: EvidenceStore,
  environment: IssueEnvironment,
): Promise<EvidenceWorkerResult> {
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
  const snapshot = store.readRecord<CandidateSnapshot>(
    "candidate-snapshots",
    input.candidateSnapshotId,
  );
  await assertSnapshotCurrent(snapshot, environment, store, false);
  const manifest = JSON.parse(
    store.readMaterial(snapshot.fileManifestMaterialId).toString(),
  ) as SnapshotFile[];
  const file = manifest.find(
    (f) => f.repoId === request.repoId && f.path === request.relativePath,
  );
  const repo = environment.repositories.find(
    (r) => r.repoId === request.repoId,
  );
  const frozen = snapshot.repositories.find((r) => r.repoId === request.repoId);
  if (!changes && (!file || !repo || !frozen || file.kind !== "file"))
    throw new Error("export_requires_snapshot_file");
  assertExportClaims(request);
  const bytes = changes
    ? await candidateChangeManifest(snapshot, environment)
    : await gitBytes(
        repo!.worktreePath,
        ["show", `${frozen!.candidateCommit}:${file!.path}`],
        { maxBuffer: MATERIAL_LIMIT, timeout: 0 },
      );
  if (!changes && digestBytes(bytes) !== file!.digest)
    throw new Error("snapshot_blob_corrupt");
  const safe = redactEvidence(bytes);
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
  const evidence = candidateExportEvidence({
    request,
    store,
    inputId: input.id,
    materialId: material.id,
    parametersId: parameters.id,
    path: changes ? undefined : file!.path,
  });
  store.sealRecord("evidence", evidence, "Evidence");
  return {
    taskId: request.taskId,
    materials: [parameters, material],
    evidence: [evidence],
  };
}

/** Each claim names a requirement of the contract that accepts this carrier. */
function assertExportClaims(request: FileExportRequest): void {
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
}

/** The evidence of an export: the file at `path`, or the change list without one. */
function candidateExportEvidence(options: {
  request: FileExportRequest;
  store: EvidenceStore;
  inputId: string;
  materialId: string;
  parametersId: string;
  path: string | undefined;
}): Evidence {
  const { request, store, path } = options;
  const now = new Date().toISOString();
  return {
    ...store.record("ev"),
    title: path ?? "Candidate change list generated by Foundry",
    description:
      path === undefined
        ? "Git-observed changes between frozen baselines and candidate commits"
        : "File exported from the sealed candidate",
    verificationInputId: options.inputId,
    claims: request.claims,
    materials: [{ materialId: options.materialId, role: "primary" }],
    source: {
      kind: "candidate_export",
      producer: store.actor,
      deviceId: store.deviceId,
    },
    collection: {
      operation: "file_export",
      collectorName:
        path === undefined
          ? "foundry-candidate-changes"
          : "foundry-candidate-export",
      collectorVersion: "1",
      inputMaterialId: options.parametersId,
      startedAt: now,
      finishedAt: now,
      outcome: "completed",
      completeness: "complete",
    },
    candidateBinding: "system_observed",
  };
}

/** One criterion's verification against the sealed candidate, as it ran. */
interface CriterionRun {
  request: VerifyRequest;
  store: EvidenceStore;
  environment: IssueEnvironment;
  input: VerificationInput;
  candidate: CandidateSnapshot;
  criterion: AcceptanceCriterion;
  verification: Verification;
  /** This task's verifier output directory. */
  directory: string;
}

async function verifyCriterion(
  request: VerifyRequest,
  store: EvidenceStore,
  environment: IssueEnvironment,
): Promise<EvidenceWorkerResult> {
  const taskId = request.taskId;
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
  const candidate = store.readRecord<CandidateSnapshot>(
    "candidate-snapshots",
    input.candidateSnapshotId,
  );
  await assertSnapshotCurrent(candidate, environment, store, false);
  const criterion = request.contract.criteria.find(
    (c) => c.id === verification.criterionId,
  );
  if (!criterion) throw new Error("unknown_criterion");
  verification.status = "running";
  verification.startedAt = new Date().toISOString();
  const directory = resolve(store.root, "verifier-output", identifier(taskId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run: CriterionRun = {
    request,
    store,
    environment,
    input,
    candidate,
    criterion,
    verification,
    directory,
  };
  try {
    if (criterion.evaluationMode === "agent") return await judgeCriterion(run);
    if (criterion.evaluationMode !== "deterministic" || !criterion.checker)
      throw new Error(
        "verifier_unavailable: an isolated agent adapter is required",
      );
    return await checkCriterion(run, criterion.checker);
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
  } finally {
    // The check's copy (with any installed dependencies) is not evidence;
    // what it produced is already sealed into the store.
    rmSync(resolve(directory, "candidate"), { recursive: true, force: true });
  }
}

/** An agent judges the criterion on the fixed evidence set. */
async function judgeCriterion(
  run: CriterionRun,
): Promise<EvidenceWorkerResult> {
  const { request, store, environment, candidate, verification, directory } =
    run;
  const evidence =
    request.action === "assess"
      ? request.evidence
      : verification.evidenceIds.map((id) =>
          store.readRecord<Evidence>("evidence", id),
        );
  if (
    evidence.length !== verification.evidenceIds.length ||
    evidence.some((e) => !verification.evidenceIds.includes(e.id))
  )
    throw new Error("fixed_evidence_set_mismatch");
  // The judge sees exactly what Accept would integrate: a clean copy of
  // the sealed candidate (tracked files only), plus its change summary.
  const copy = resolve(directory, "candidate"),
    changes = resolve(directory, "changes");
  let judged: Awaited<ReturnType<typeof judgeWithAgent>>;
  try {
    await materializeCandidate(candidate, environment, store, copy);
    await writeCandidateChanges(candidate, environment, changes);
    judged = await judgeWithAgent({
      contract: request.contract,
      criterion: run.criterion,
      input: run.input,
      verification,
      evidence,
      store,
      directory,
      workspace: {
        path: copy,
        changes,
        readRoots: [changes],
        skills:
          request.action === "assess" && request.skillRefs?.length
            ? await materializeSessionSkills(
                request.skillRefs,
                environment.controlServerURL ?? "",
                copy,
              )
            : undefined,
      },
    });
  } finally {
    rmSync(copy, { recursive: true, force: true });
    rmSync(changes, { recursive: true, force: true });
  }
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
    taskId: request.taskId,
    verification,
    materials: [
      store.getMaterial(judged.result.rawOutputMaterialId),
      store.getMaterial(judged.result.reportMaterialId),
    ],
  };
}

/** A fixed checker collects the reserved evidence and judges its assertions. */
async function checkCriterion(
  run: CriterionRun,
  checker: CheckDefinition,
): Promise<EvidenceWorkerResult> {
  const { request, store, candidate, criterion, verification, directory } = run;
  const taskId = request.taskId;
  const candidateDirectory = resolve(directory, "candidate"),
    outputDirectory = resolve(directory, "output");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  await materializeCandidate(
    candidate,
    run.environment,
    store,
    candidateDirectory,
  );
  if (verification.evidenceIds.length !== 1)
    throw new Error("reserved_collection_required");
  const evidenceId = identifier(verification.evidenceIds[0]!);
  // Command checks run with the dependencies of the recorded lockfiles,
  // installed offline into this check's copy; the install log is evidence.
  const supportingMaterials: Material[] = [];
  let dependencySandbox: DependencySandbox | undefined;
  if (checker.configuration.kind !== "http") {
    const prepared = await prepareCheckDependencies(
      run,
      candidateDirectory,
      outputDirectory,
    );
    if (prepared.log) supportingMaterials.push(prepared.log);
    dependencySandbox = prepared.sandbox;
    if (prepared.failure) {
      verification.status = "failed";
      verification.error = {
        code: "dependencies_unavailable",
        message: prepared.failure,
        retryable: true,
      };
      verification.finishedAt = new Date().toISOString();
      store.sealRecord("verifier-output", verification, "Verification");
      return {
        taskId,
        verification,
        materials: prepared.log ? [prepared.log] : [],
      };
    }
  }
  const capture = await collectCheckEvidence(run, checker, {
    evidenceId,
    candidateDirectory,
    outputDirectory,
    supportingMaterials,
    dependencySandbox,
  });
  if (capture.technicalError) {
    verification.status = "failed";
    verification.error = capture.technicalError;
  } else {
    const judged = programJudgment(run, checker, capture);
    verification.result = judged.result;
    verification.status = "completed";
    capture.materials.push(...judged.materials);
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
}

/**
 * The recorded lockfiles' dependencies installed offline into the check's
 * copy: the sealed install log, the sandbox they run in, or why they could not.
 */
async function prepareCheckDependencies(
  run: CriterionRun,
  candidateDirectory: string,
  outputDirectory: string,
): Promise<{ log?: Material; sandbox?: DependencySandbox; failure?: string }> {
  const locks = dependencyLocks(run.candidate, run.store);
  const recorded = run.input.dependencies
    .filter((d) => d.kind === "dependency_lock")
    .map((d) => `${d.name}@${d.versionToken}`)
    .sort();
  if (
    JSON.stringify(locks.map((l) => `${l.name}@${l.digest}`)) !==
    JSON.stringify(recorded)
  )
    throw new Error(
      "input_unbound: the candidate's lockfiles differ from its verification input",
    );
  if (!locks.length) return {};
  const prepared = await prepareDependencies(
    locks,
    candidateDirectory,
    outputDirectory,
  );
  const safe = redactEvidence(prepared.log);
  const log = run.store.sealMaterial(
    "Dependency preparation log",
    "text_log",
    safe.bytes,
    safe.redaction,
  );
  return { log, sandbox: prepared.sandbox, failure: prepared.failure };
}

/** The checker's collector run into the reserved evidence. */
function collectCheckEvidence(
  run: CriterionRun,
  checker: CheckDefinition,
  options: {
    evidenceId: string;
    candidateDirectory: string;
    outputDirectory: string;
    supportingMaterials: Material[];
    dependencySandbox: DependencySandbox | undefined;
  },
): Promise<CollectionResult> {
  const { input, store, candidate, criterion } = run;
  const { evidenceId, candidateDirectory, outputDirectory } = options;
  const claims = criterion.evidenceRequirements.map((r) => ({
    criterionId: criterion.id,
    requirementId: r.id,
    purpose: r.description,
  }));
  const configuration = checker.configuration;
  if (configuration.kind === "http") {
    const target = input.targets.find(
      (t) => t.name === configuration.targetName,
    );
    return collectHTTP({
      evidenceId,
      checker,
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
    });
  }
  const command = {
    evidenceId,
    checker,
    input,
    claims,
    candidateDirectory,
    outputDirectory,
    store,
    supportingMaterials: options.supportingMaterials,
    launch: (invocation: CommandInvocation) =>
      runEvidenceCommand(
        invocation,
        candidateDirectory,
        outputDirectory,
        options.dependencySandbox,
      ),
  };
  return configuration.kind === "project_command"
    ? collectProjectCommand(command)
    : collectCommand(command);
}

/** The verdict of the checker's fixed assertions, with its sealed raw output and report. */
function programJudgment(
  run: CriterionRun,
  checker: CheckDefinition,
  capture: CollectionResult,
): { result: VerificationResult; materials: Material[] } {
  const { store, criterion } = run;
  const configuration = checker.configuration;
  const raw = store.sealMaterial(
    "Program judgment",
    "data",
    Buffer.from(JSON.stringify({ assertions: capture.assertions })),
  );
  const summary =
    configuration.kind === "project_command"
      ? `Foundry ran ${shortCommand([configuration.executable, ...configuration.args].join(" "))}, exit code ${capture.evidence.collection.exitCode ?? "unknown"}`
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
  return {
    result: {
      verdict: capture.verdict!,
      summary,
      reasoning: "Fixed assertions evaluated against sealed candidate inputs.",
      findings,
      limitations: [],
      unmetRequirementIds: [],
      rawOutputMaterialId: raw.id,
      reportMaterialId: report.id,
      completedAt: new Date().toISOString(),
    },
    materials: [raw, report],
  };
}

/** A command short enough to read in a result; the full one stays in the checker and its log. */
function shortCommand(command: string): string {
  return command.length > 80 ? `${command.slice(0, 77)}…` : command;
}
