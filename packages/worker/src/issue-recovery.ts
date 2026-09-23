import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue, Run } from "@foundry/protocol";
import { ExecutionStore } from "./execution-storage.js";
import { readWorkspace } from "./workspaces.js";
import {
  getJSON,
  HttpRunTransport,
  postJSON,
  type IssueCompletion,
} from "./transport.js";
import { writeJSON } from "./storage.js";

/** Run once before accepting work in a replacement daemon process. */
export async function recoverIssueRuns(
  serverURL: string,
  source: string,
  store = new ExecutionStore(),
): Promise<void> {
  const workspace = readWorkspace(source);
  const issues = await getJSON<Issue[]>(
    serverURL,
    `/api/issues?workspaceId=${encodeURIComponent(workspace.id)}`,
  );
  const transport = new HttpRunTransport(serverURL);
  const roots = new Set([resolve(store.executionRoot, workspace.id, "runs")]);
  const pointers = resolve(
    store.metadata(workspace.id),
    "environment-locations",
  );
  if (existsSync(pointers))
    for (const name of readdirSync(pointers)) {
      if (!name.endsWith(".json")) continue;
      const environment = store.environment(workspace.id, name.slice(0, -5));
      if (environment) roots.add(resolve(environment.directory, "../../runs"));
    }
  for (const issue of issues.filter((item) => item.status === "in_progress")) {
    if (!issue.run || issue.run.status !== "running") {
      // Claimed but not started; no execution was created on the server.
      await postJSON(
        serverURL,
        `/api/daemon/issues/${issue.id}/recover-claim`,
        {},
      );
      continue;
    }
    const root = [...roots].find((path) =>
      existsSync(resolve(path, issue.run!.id, "run.json")),
    );
    if (!root) continue; // Legacy executions retain their existing recovery path.
    await store.lock(workspace.id, `execution-${issue.id}`, async () => {
      const runDir = resolve(root, issue.run!.id);
      const completionPath = resolve(runDir, "completion.json");
      let completion: IssueCompletion;
      if (existsSync(completionPath))
        completion = JSON.parse(readFileSync(completionPath, "utf8"));
      else {
        const run = JSON.parse(
          readFileSync(resolve(runDir, "run.json"), "utf8"),
        ) as Run;
        const environment = store.environment(workspace.id, issue.id);
        const error =
          "Worker process stopped. Candidate files and the native session are retained; retry to resume.";
        if (environment) {
          environment.status = "failed";
          environment.error = error;
          store.saveEnvironment(environment);
        }
        completion = {
          runId: run.id,
          artifact: {
            id: `art_${run.id}`,
            issueId: issue.id,
            kind: "text",
            title: "Interrupted execution",
            summary: error,
          },
          checks: [error],
          error,
          environmentId: environment?.id,
          executionCwd: environment?.cwd,
        };
        writeJSON(completionPath, completion);
      }
      await transport.completeIssue(issue.id, completion);
    });
  }
}
