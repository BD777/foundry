import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatAttachment, Issue } from "@bd777/foundry-protocol";
import { EvidenceStore } from "./evidence-store.js";
import { ExecutionStore, identifier } from "./execution-storage.js";
import type { IssueEnvironment } from "./execution-types.js";

/** Where an Issue's reference materials are readable by its processes. */
export function issueReferencesDirectory(
  environment: IssueEnvironment,
): string {
  return resolve(environment.directory, "references");
}

/**
 * The reference materials the confirmed contract names (goal and rubric
 * media), as read-only files beside the candidate, for the execution to look
 * at. They are targets to work towards, never evidence of the result.
 */
export function issueReferences(
  environment: IssueEnvironment,
  issue: Issue,
  store = new ExecutionStore(),
): ChatAttachment[] {
  const contract = issue.executionContract;
  if (!contract) return [];
  const media = [
    ...contract.goal.media,
    ...contract.criteria.flatMap((criterion) => criterion.rubric.media),
  ];
  const directory = issueReferencesDirectory(environment);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const materials = new EvidenceStore(
    environment.workspaceId,
    environment.issueId,
    "worker",
    { kind: "daemon", id: "worker", displayName: "Foundry Worker" },
    store,
  );
  const attachments = new Map<string, ChatAttachment>();
  for (const { materialId, caption } of media) {
    if (attachments.has(materialId)) continue;
    const material = materials.getMaterial(materialId);
    const path = resolve(directory, identifier(materialId));
    const bytes = materials.readMaterial(materialId);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 });
    attachments.set(materialId, {
      id: materialId,
      name: caption || material.name,
      path,
      mimeType: material.mimeType,
      size: bytes.length,
      kind: material.mimeType.startsWith("image/") ? "image" : "file",
    });
  }
  return [...attachments.values()];
}
