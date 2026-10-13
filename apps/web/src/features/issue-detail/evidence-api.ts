import type {
  CandidateSnapshot,
  ContractDraftInput,
  EvidenceClaim,
  HumanAssessment,
  Issue,
  IssueContract,
  Material,
  ReviewSnapshot,
  Verification,
  VerificationInput,
} from "@bd777/foundry-protocol";
import { request, send } from "../../api";
import { i18n } from "../../i18n";

const path = (id: string) => `/api/issues/${encodeURIComponent(id)}`;
const materialContentPath = (id: string, material: Material) =>
  `${path(id)}/materials/${encodeURIComponent(material.id)}/content`;
async function listRecords<T extends { id: string }>(
  url: string,
): Promise<{ items: T[] }> {
  const records = new Map<string, T>();
  let total = 0;
  for (let page = 1; page === 1 || (page - 1) * 100 < total; page++) {
    const result = await request<{ items: T[]; total: number }>(
      "GET",
      `${url}?page=${page}&pageSize=100`,
    );
    if (page === 1) total = result.total;
    for (const record of result.items) records.set(record.id, record);
    if (!result.items.length) break;
  }
  return { items: [...records.values()] };
}
export function listContracts(id: string) {
  return listRecords<IssueContract>(`${path(id)}/contracts`);
}
export function askIssueStatus(id: string, message: string, key: string) {
  return request("POST", `${path(id)}/conversation/status`, {
    body: { message },
    idempotencyKey: key,
  });
}
export function importLegacyContract(id: string, key: string) {
  return request<IssueContract>("POST", `${path(id)}/contracts/import-legacy`, {
    body: {},
    idempotencyKey: key,
  });
}
export function saveContract(
  id: string,
  input: ContractDraftInput,
  key: string,
) {
  return request<IssueContract>("POST", `${path(id)}/contracts`, {
    body: input,
    idempotencyKey: key,
  });
}
/** Sends a message to the Issue's clarification session; the reply arrives with the Issue. */
export function clarifyContract(
  id: string,
  draft: IssueContract,
  message: string,
  changeReason: string,
  key: string,
) {
  return request<Issue>("POST", `${path(id)}/clarify`, {
    body: {
      expectedRevision: draft.revision,
      expectedContentDigest: draft.contentDigest,
      message,
      changeReason,
    },
    idempotencyKey: key,
  });
}
/** Asks the clarification session again after it failed to answer. */
export function retryClarification(id: string, key: string) {
  return request<Issue>("POST", `${path(id)}/clarify/retry`, {
    body: {},
    idempotencyKey: key,
  });
}
export function confirmContract(id: string, c: IssueContract, key: string) {
  return request<IssueContract>(
    "POST",
    `${path(id)}/contracts/${c.revision}/confirm`,
    { body: { expectedContentDigest: c.contentDigest }, idempotencyKey: key },
  );
}
export function discardContract(
  id: string,
  c: IssueContract,
  reason: string,
  key: string,
) {
  return request<IssueContract>(
    "POST",
    `${path(id)}/contracts/${c.revision}/discard`,
    { body: { reason }, idempotencyKey: key },
  );
}
export function getEvidenceReview(id: string) {
  return request<ReviewSnapshot>("GET", `${path(id)}/review`);
}
export function listVerifications(id: string) {
  return listRecords<Verification>(`${path(id)}/verifications`);
}
export function listHumanAssessments(id: string) {
  return listRecords<HumanAssessment>(`${path(id)}/human-assessments`);
}
export function listMaterials(id: string) {
  return listRecords<Material>(`${path(id)}/materials`);
}
export function listInputs(id: string) {
  return listRecords<VerificationInput>(`${path(id)}/verification-inputs`);
}
export function listCandidates(id: string) {
  return listRecords<CandidateSnapshot>(`${path(id)}/candidate-snapshots`);
}
export function getMaterial(id: string, materialId: string) {
  return request<Material>(
    "GET",
    `${path(id)}/materials/${encodeURIComponent(materialId)}`,
  );
}
export async function readPreviewMaterial(
  id: string,
  material: Material,
): Promise<Blob> {
  const isImage = ["image/png", "image/jpeg", "image/gif"].includes(
    material.mimeType,
  );
  const isText = ["text/plain", "application/json"].includes(material.mimeType);
  const isPdf = material.mimeType === "application/pdf";
  if (
    (!isImage && !isText && !isPdf) ||
    material.byteSize >
      (isImage ? 25 * 1024 * 1024 : isPdf ? 32 * 1024 * 1024 : 2 * 1024 * 1024)
  )
    throw new Error(i18n.t("issueDetail:preview.unavailable"));
  const response = await send("GET", materialContentPath(id, material));
  const bytes = await response.arrayBuffer();
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (
    bytes.byteLength !== material.byteSize ||
    `sha256:${digest}` !== material.digest
  )
    throw new Error(
      "material_corrupt: preview does not match the sealed original",
    );
  return new Blob([bytes], { type: material.mimeType });
}
export function registerHumanEvidence(
  id: string,
  input: VerificationInput,
  material: Material,
  claims: EvidenceClaim[],
  attestation: string,
  parameters: Material,
  key: string,
) {
  return request("POST", `${path(id)}/evidence`, {
    body: {
      expectedContractRevision: input.contractRevision,
      verificationInputId: input.id,
      title: material.name,
      description: attestation,
      claims,
      materialIds: [material.id],
      attestation,
      collectionInputMaterialId: parameters.id,
    },
    idempotencyKey: key,
  });
}
export function exportCandidateEvidence(
  id: string,
  input: VerificationInput,
  repoId: string,
  relativePath: string,
  claims: EvidenceClaim[],
  key: string,
  carrier: Material["carrier"] = "document",
  sourceKind: "candidate_file" | "candidate_changes" = "candidate_file",
) {
  return request("POST", `${path(id)}/evidence/export`, {
    body: {
      expectedContractRevision: input.contractRevision,
      verificationInputId: input.id,
      repoId,
      relativePath,
      claims,
      carrier,
      sourceKind,
    },
    idempotencyKey: key,
  });
}
export async function downloadMaterial(
  id: string,
  material: Material,
): Promise<void> {
  const response = await send("GET", materialContentPath(id, material));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = material.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function sealCandidate(
  id: string,
  revision: number,
  key: string,
  httpTargets: { name: string; entrypointRelativePath: string }[] = [],
  alignFromSnapshotId?: string,
) {
  return request<{ candidate: { id: string } }>(
    "POST",
    `${path(id)}/candidate-snapshots`,
    {
      body: {
        expectedContractRevision: revision,
        httpTargets,
        alignFromSnapshotId,
      },
      idempotencyKey: key,
    },
  );
}
export function verifyCriteria(
  id: string,
  revision: number,
  snapshotId: string,
  criterionIds: string[],
  key: string,
) {
  return request("POST", `${path(id)}/verify`, {
    body: {
      expectedContractRevision: revision,
      expectedCandidateSnapshotId: snapshotId,
      criterionIds,
    },
    idempotencyKey: key,
  });
}
export function assessVerification(
  id: string,
  v: Verification,
  verdict: string,
  reason: string,
  key: string,
) {
  return request("POST", `${path(id)}/human-assessments`, {
    body: {
      verificationId: v.id,
      verdict,
      rationale: { text: reason, media: [] },
      evidenceCitations:
        v.result?.findings.flatMap((f) => f.evidenceCitations) ?? [],
    },
    idempotencyKey: key,
  });
}
export function acceptReviewedCandidate(
  id: string,
  review: ReviewSnapshot,
  key: string,
) {
  return request("POST", `${path(id)}/accept`, {
    body: { reviewSnapshotId: review.id, reviewDigest: review.digest },
    idempotencyKey: key,
  });
}
export async function uploadMaterial(
  id: string,
  file: File,
  carrier: Material["carrier"],
  key: string,
): Promise<Material> {
  return request(
    "POST",
    `${path(id)}/materials?${new URLSearchParams({ name: file.name, carrier })}`,
    { body: file, idempotencyKey: key },
  );
}
