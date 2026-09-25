import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Issue,
  Run,
  RunEvent,
  AcceptanceArtifact,
  SessionSkillRef,
} from "@foundry/protocol";
import { validateEvidenceModel } from "@foundry/protocol";
import { ExecutionStore } from "./execution-storage.js";
import {
  prepareIssueEnvironment,
  snapshotEnvironment,
} from "./issue-environments.js";
import { runIssueExecutor } from "./issue-executor.js";
import { readWorkspace } from "./workspaces.js";
import { HttpRunTransport, type RunTransport } from "./transport.js";
import { writeJSON } from "./storage.js";
import type { IssueEnvironment } from "./execution-types.js";
import { refreshCandidate } from "./candidate-refresh.js";
import {
  beginIssueExecution,
  finishIssueExecution,
} from "./execution-process.js";

export async function executeIssue(
  serverURL: string,
  workspacePath: string,
  issue: Issue,
  transport: RunTransport = new HttpRunTransport(serverURL),
  store = new ExecutionStore(),
  skillRefs: SessionSkillRef[] = [],
  userFiles: "readable" | "hidden" = "hidden",
): Promise<void> {
  if (
    issue.contractState !== "confirmed" ||
    !issue.currentContractRevision ||
    issue.draftContractRevision
  )
    throw new Error(
      "contract_confirmation_required: confirm the exact criterion contract before execution",
    );
  const contract = issue.executionContract;
  if (
    !contract ||
    validateEvidenceModel("IssueContract", contract).length ||
    contract.issueId !== issue.id ||
    contract.workspaceId !== issue.workspaceId ||
    contract.revision !== issue.currentContractRevision ||
    contract.status !== "confirmed" ||
    contract.confirmation?.contentDigest !== contract.contentDigest ||
    !["user", "local_owner"].includes(contract.confirmation.actor.kind)
  )
    throw new Error("confirmed_execution_contract_required");
  const workspace = readWorkspace(workspacePath);
  if (issue.workspaceId && issue.workspaceId !== workspace.id)
    throw new Error("Issue belongs to another workspace");
  return store.lock(workspace.id, `execution-${issue.id}`, async () => {
    const runId = `run_${randomUUID()}`;
    const retained = store.environment(workspace.id, issue.id);
    const runDir = retained
      ? store.runDirectory(retained, runId)
      : resolve(store.executionRoot, workspace.id, "runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const run: Run = {
      id: runId,
      issueId: issue.id,
      workspaceId: workspace.id,
      runtime: issue.runtime,
      status: "running",
      startedLabel: "just now",
      startedAt: new Date().toISOString(),
      events: [],
    };
    const artifact: AcceptanceArtifact = {
      id: `art_${randomUUID()}`,
      issueId: issue.id,
      kind: "text",
      title: `${issue.shortId} execution report`,
      summary: "Candidate workspace changes and validation",
      primaryUri: resolve(runDir, "acceptance.md"),
    };
    writeJSON(resolve(runDir, "run.json"), run);
    writeJSON(resolve(runDir, "issue.json"), issue);
    await transport.startRun(issue.id, run);
    const record = async (
      label: string,
      detail: string,
      level: RunEvent["level"] = "info",
    ): Promise<void> => {
      const event: RunEvent = {
        id: `evt_${randomUUID()}`,
        runId,
        at: new Date().toISOString(),
        label,
        detail,
        level,
      };
      run.events.push(event);
      appendFileSync(
        resolve(runDir, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
      );
      await transport.appendRunEvent(runId, event);
    };
    let environment: IssueEnvironment | undefined;
    let response = "";
    const control = beginIssueExecution(issue.id);
    try {
      control.signal.throwIfAborted();
      environment = await prepareIssueEnvironment(
        workspacePath,
        workspace.id,
        issue.id,
        store,
      );
      environment.contractRevision = issue.currentContractRevision;
      environment.controlIsolationVersion = 1;
      environment.controlServerURL = serverURL;
      environment.userFiles = userFiles;
      store.saveEnvironment(environment);
      if (issue.checks.includes("Changes requested"))
        environment = await refreshCandidate(environment, store);
      await record("Candidate workspace ready", environment.cwd);
      if (issue.runtime === "mock") {
        response = `# ${issue.title}\n\n${issue.sourceInput}\n\nMock execution completed in an isolated Issue worktree.\n`;
        writeFileSync(
          resolve(environment.cwd, `foundry-result-${issue.id}.md`),
          response,
        );
      } else {
        const result = await runIssueExecutor(
          environment,
          issue,
          runId,
          record,
          store,
          undefined,
          control.signal,
          serverURL,
          skillRefs,
        );
        environment = result.environment;
        response = result.response;
      }
      environment = await store.lock(
        workspace.id,
        `environment-${issue.id}`,
        () => snapshotEnvironment(environment!, store),
      );
      run.environmentId = environment.id;
      run.environmentRevision = environment.revision;
      run.executionCwd = environment.cwd;
      run.status = "completed";
      writeFileSync(
        artifact.primaryUri!,
        `${response}\n\nCandidate revision: ${environment.revision}\nCWD: ${environment.cwd}\n\n${environment.repositories.map((repo) => `- ${repo.relativePath}: ${repo.candidate}`).join("\n")}\n`,
      );
      await record(
        "Awaiting Workspace Accept",
        `${environment.repositories.length} repositories; candidate revision ${environment.revision}`,
      );
    } catch (error) {
      run.status = control.signal.aborted ? "canceled" : "failed";
      run.error = control.signal.aborted
        ? "Issue execution canceled; candidate files are retained"
        : String(error);
      if (environment) {
        environment = store.environment(workspace.id, issue.id) ?? environment;
        environment.status = "failed";
        environment.error = run.error;
        store.saveEnvironment(environment);
        run.environmentId = environment.id;
        run.executionCwd = environment.cwd;
      }
      writeFileSync(
        artifact.primaryUri!,
        `Execution failed. Candidate files are retained.\n\n${run.error}\n`,
      );
      await record("Issue execution failed", run.error, "error");
    } finally {
      finishIssueExecution(issue.id);
    }
    run.completedAt = new Date().toISOString();
    writeJSON(resolve(runDir, "run.json"), run);
    const completion = {
      canceled: run.status === "canceled",
      response: response.slice(0, 64_000),
      runId,
      artifact,
      checks: run.error
        ? [run.error]
        : ["Candidate changes await explicit Workspace Accept"],
      environmentId: run.environmentId,
      environmentRevision: run.environmentRevision,
      executionCwd: run.executionCwd,
      error: run.error,
    };
    writeJSON(resolve(runDir, "completion.json"), completion);
    await transport.completeIssue(issue.id, completion);
  });
}
