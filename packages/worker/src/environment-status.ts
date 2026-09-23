import { existsSync, readdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { ExecutionStore } from "./execution-storage.js";
import { previewStatus } from "./issue-preview.js";

export function environmentStatus(
  workspaceId: string,
  issueId: string,
  store = new ExecutionStore(),
): unknown {
  const environment = store.environment(workspaceId, issueId);
  const registration = store.registration(workspaceId);
  if (!environment)
    return {
      status: "not_prepared",
      repositories:
        registration?.repositories.map((repo) => ({
          path: repo.relativePath,
          kind: repo.kind,
          status: "unprepared",
          availability: repo.status,
          error: repo.error,
        })) ?? [],
    };
  let bytes = 0,
    files = 0;
  function size(path: string): void {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = resolve(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) size(next);
      else {
        try {
          bytes += lstatSync(next).size;
          files++;
        } catch {
          /* Concurrent scratch output may disappear. */
        }
      }
    }
  }
  size(environment.directory);
  return {
    status: environment.status,
    cwd: environment.cwd,
    revision: environment.revision,
    bytes,
    files,
    error: environment.error,
    hasPreview: existsSync(
      resolve(environment.sourcePath, ".foundry/preview.json"),
    ),
    preview: previewStatus(issueId),
    content: registration?.content,
    repositories:
      registration?.repositories.map((repo) => {
        const candidate = environment.repositories.find(
          (item) => item.repoId === repo.id,
        );
        return {
          path: repo.relativePath,
          kind: repo.kind,
          status: candidate?.status ?? "unprepared",
          availability: repo.status,
          error: candidate?.error ?? repo.error,
        };
      }) ?? [],
  };
}
