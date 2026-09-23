import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CandidateSnapshot,
  EvidenceWorkerRequest,
  EvidenceWorkerResult,
} from "@foundry/protocol";
import { EvidenceStore } from "./evidence-store.js";
import { ExecutionStore, identifier } from "./execution-storage.js";
import { assertSnapshotCurrent } from "./evidence-snapshots.js";
import { prepareAcceptance, applyAcceptance } from "./workspace-acceptance.js";
import type {
  WorkspaceAcceptance,
  IssueEnvironment,
} from "./execution-types.js";
import { git } from "./execution-git.js";
import { writeJSON } from "./storage.js";

export async function acceptEvidenceCandidate(
  request: Extract<
    EvidenceWorkerRequest,
    { action: "accept" | "check_accept" }
  >,
  store: EvidenceStore,
  execution: ExecutionStore,
): Promise<EvidenceWorkerResult> {
  return execution.lock(
    request.workspaceId,
    `execution-${request.issueId}`,
    async () => {
      const environment = execution.environment(
        request.workspaceId,
        request.issueId,
      );
      if (!environment) throw new Error("candidate_missing");
      if (environment.controlIsolationVersion !== 1)
        throw new Error("execution_isolation_required");
      if (process.platform !== "darwin")
        throw new Error("execution_isolation_unverified_on_this_platform");
      const candidate = store.readRecord<CandidateSnapshot>(
        "candidate-snapshots",
        request.candidate.id,
      );
      if (candidate.contentDigest !== request.candidate.contentDigest)
        throw new Error("candidate_changed");
      for (const id of request.materialIds) store.readMaterial(id);
      if (request.action === "check_accept") {
        if (request.decisionId && environment.acceptanceId) {
          const journal = readAcceptance(environment);
          if (
            journal.decisionId !== request.decisionId ||
            journal.candidateSnapshotId !== candidate.id
          )
            throw new Error("integration_in_progress_for_another_decision");
          await validateJournalCandidate(
            candidate,
            environment,
            journal,
            store,
          );
        } else {
          await assertSnapshotCurrent(candidate, environment, store);
        }
        return { taskId: request.taskId, status: "checked" };
      }
      if (
        request.decision.status !== "approved" ||
        request.decision.candidateSnapshotId !== candidate.id ||
        request.decision.reviewSnapshotId !== request.review.id ||
        request.decision.reviewDigest !== request.review.digest ||
        !request.review.eligible ||
        !["local_owner", "user"].includes(request.decision.createdBy.kind)
      )
        throw new Error("invalid_acceptance_decision");
      let acceptance: WorkspaceAcceptance;
      if (environment.acceptanceId) {
        acceptance = readAcceptance(environment);
        if (acceptance.decisionId !== request.decision.id)
          throw new Error("integration_in_progress_for_another_decision");
        if (acceptance.status === "integrated") {
          await validateJournalCandidate(
            candidate,
            environment,
            acceptance,
            store,
          );
          return {
            taskId: request.taskId,
            status: "integrated",
            integrationId: acceptance.id,
            integrationSnapshot: store.readRecord<CandidateSnapshot>(
              "candidate-snapshots",
              acceptance.integrationSnapshotId!,
            ),
          };
        }
      } else {
        await assertSnapshotCurrent(candidate, environment, store);
        acceptance = await prepareAcceptance(
          request.workspaceId,
          request.issueId,
          environment.revision,
          execution,
        );
        if (acceptance.status === "conflict")
          throw new Error(acceptance.error ?? "integration_conflict");
        // No implicit alignment: every merged tree must be the exact verified tree.
        for (const repo of acceptance.repositories) {
          const frozen = candidate.repositories.find(
            (r) => r.repoId === repo.repoId,
          );
          if (
            !frozen ||
            repo.expected !== frozen.baselineCommit ||
            (await git(repo.worktreePath, [
              "rev-parse",
              `${repo.target}^{tree}`,
            ])) !== frozen.treeOid
          )
            throw new Error(
              "baseline_changed: align candidate, reverify, then request a new human Accept",
            );
        }
        const integration: CandidateSnapshot = {
          ...candidate,
          ...store.record("snap"),
          purpose: "integration",
          parentSnapshotId: candidate.id,
          capturedAt: new Date().toISOString(),
          repositories: candidate.repositories.map((repo) => ({
            ...repo,
            candidateCommit: acceptance.repositories.find(
              (r) => r.repoId === repo.repoId,
            )!.target,
          })),
        };
        // The tree and baseline are identical; keep the product content fingerprint.
        store.sealRecord(
          "candidate-snapshots",
          integration,
          "CandidateSnapshot",
        );
        acceptance.decisionId = request.decision.id;
        acceptance.reviewSnapshotId = request.review.id;
        acceptance.candidateSnapshotId = candidate.id;
        acceptance.integrationSnapshotId = integration.id;
        acceptance.finalVerificationIds =
          request.review.criterionResults.flatMap((r) =>
            r.verificationId ? [r.verificationId] : [],
          );
        writeJSON(
          resolve(
            environment.directory,
            "../../acceptances",
            acceptance.id,
            "acceptance.json",
          ),
          acceptance,
        );
        environment.acceptanceId = acceptance.id;
        execution.saveEnvironment(environment);
      }
      acceptance = await applyAcceptance(
        request.workspaceId,
        request.issueId,
        acceptance.id,
        environment.revision,
        execution,
        async (current, journal) => {
          for (const id of request.materialIds) store.readMaterial(id);
          await validateJournalCandidate(candidate, current, journal, store);
        },
      );
      return {
        taskId: request.taskId,
        status: acceptance.status,
        integrationId: acceptance.id,
        integrationSnapshot: store.readRecord<CandidateSnapshot>(
          "candidate-snapshots",
          acceptance.integrationSnapshotId!,
        ),
      };
    },
  );
}

function readAcceptance(environment: IssueEnvironment): WorkspaceAcceptance {
  const path = resolve(
    environment.directory,
    "../../acceptances",
    identifier(environment.acceptanceId!),
    "acceptance.json",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

async function validateJournalCandidate(
  candidate: CandidateSnapshot,
  environment: IssueEnvironment,
  journal: WorkspaceAcceptance,
  store: EvidenceStore,
): Promise<void> {
  await assertSnapshotCurrent(candidate, environment, store, false);
  if (
    journal.candidateSnapshotId !== candidate.id ||
    journal.repositories.length !== candidate.repositories.length
  )
    throw new Error("integration_content_changed");
  for (const frozen of candidate.repositories) {
    const applied = journal.repositories.find(
      (r) => r.repoId === frozen.repoId,
    );
    const repo = environment.repositories.find(
      (r) => r.repoId === frozen.repoId,
    );
    if (!applied || !repo || applied.expected !== frozen.baselineCommit)
      throw new Error("baseline_changed");
    const head = await git(repo.sourcePath, ["rev-parse", frozen.baselineRef]);
    if (head !== applied.expected && head !== applied.target)
      throw new Error("baseline_changed");
    if (
      (await git(applied.worktreePath, [
        "rev-parse",
        `${applied.target}^{tree}`,
      ])) !== frozen.treeOid
    )
      throw new Error("integration_content_changed");
  }
}
