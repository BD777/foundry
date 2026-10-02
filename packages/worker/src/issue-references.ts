import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatAttachment, Issue } from "@bd777/foundry-protocol";
import { EvidenceStore } from "./evidence-store.js";
import { ExecutionStore } from "./execution-storage.js";
import { referenceFiles } from "./reference-files.js";
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
 * at. They are targets to work towards, never evidence of the result. A PDF
 * also comes as its extracted text, for runtimes that cannot read PDFs.
 */
export async function issueReferences(
  environment: IssueEnvironment,
  issue: Issue,
  store = new ExecutionStore(),
): Promise<ChatAttachment[]> {
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
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const { materialId, caption } of media) {
    if (seen.has(materialId)) continue;
    seen.add(materialId);
    const material = materials.getMaterial(materialId);
    const { original, text } = await referenceFiles(
      directory,
      material,
      caption || material.name,
      materials.readMaterial(materialId),
    );
    attachments.push(original, ...(text ? [text] : []));
  }
  return attachments;
}
