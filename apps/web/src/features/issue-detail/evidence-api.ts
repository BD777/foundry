import type {
  CandidateSnapshot,
  ContractDraftInput,
  Evidence,
  EvidenceClaim,
  HumanAssessment,
  IssueContract,
  Material,
  ReviewSnapshot,
  Verification,
  VerificationInput,
} from "@foundry/protocol";
import { apiFetch } from "../../api";

const base = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:31982";
async function request<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await apiFetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}
const path = (id: string) => `/api/issues/${encodeURIComponent(id)}`;
async function listRecords<T extends { id: string }>(
  url: string,
): Promise<{ items: T[] }> {
  const records = new Map<string, T>();
  let total = 0;
  for (let page = 1; page === 1 || (page - 1) * 100 < total; page++) {
    const result = await request<{ items: T[]; total: number }>(
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
  return request(`${path(id)}/conversation/status`, { message }, key);
}
export function importLegacyContract(id: string, key: string) {
  return request<IssueContract>(`${path(id)}/contracts/import-legacy`, {}, key);
}
export function saveContract(
  id: string,
  input: ContractDraftInput,
  key: string,
) {
  return request<IssueContract>(`${path(id)}/contracts`, input, key);
}
export function clarifyContract(
  id: string,
  draft: IssueContract,
  message: string,
  changeReason: string,
  key: string,
) {
  return request(
    `${path(id)}/clarify`,
    {
      expectedRevision: draft.revision,
      expectedContentDigest: draft.contentDigest,
      message,
      changeReason,
    },
    key,
  );
}
export function confirmContract(id: string, c: IssueContract, key: string) {
  return request<IssueContract>(
    `${path(id)}/contracts/${c.revision}/confirm`,
    { expectedContentDigest: c.contentDigest },
    key,
  );
}
export function discardContract(
  id: string,
  c: IssueContract,
  reason: string,
  key: string,
) {
  return request<IssueContract>(
    `${path(id)}/contracts/${c.revision}/discard`,
    { reason },
    key,
  );
}
export function getEvidenceReview(id: string) {
  return request<ReviewSnapshot>(`${path(id)}/review`);
}
export function listVerifications(id: string) {
  return listRecords<Verification>(`${path(id)}/verifications`);
}
export function listHumanAssessments(id: string) {
  return listRecords<HumanAssessment>(`${path(id)}/human-assessments`);
}
export function listEvidence(id: string) {
  return listRecords<Evidence>(`${path(id)}/evidence`);
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
  if (
    (!isImage && !isText) ||
    material.byteSize > (isImage ? 25 * 1024 * 1024 : 2 * 1024 * 1024)
  )
    throw new Error(
      "Preview unavailable for this format or size; download the original.",
    );
  const response = await apiFetch(
    `${base}${path(id)}/materials/${encodeURIComponent(material.id)}/content`,
  );
  if (!response.ok) throw new Error(await response.text());
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
  return request(
    `${path(id)}/evidence`,
    {
      expectedContractRevision: input.contractRevision,
      verificationInputId: input.id,
      title: material.name,
      description: attestation,
      claims,
      materialIds: [material.id],
      attestation,
      collectionInputMaterialId: parameters.id,
    },
    key,
  );
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
  return request(
    `${path(id)}/evidence/export`,
    {
      expectedContractRevision: input.contractRevision,
      verificationInputId: input.id,
      repoId,
      relativePath,
      claims,
      carrier,
      sourceKind,
    },
    key,
  );
}
export async function downloadMaterial(
  id: string,
  material: Material,
): Promise<void> {
  const response = await apiFetch(
    `${base}${path(id)}/materials/${encodeURIComponent(material.id)}/content`,
  );
  if (!response.ok) throw new Error(await response.text());
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
    `${path(id)}/candidate-snapshots`,
    { expectedContractRevision: revision, httpTargets, alignFromSnapshotId },
    key,
  );
}
export function verifyCriteria(
  id: string,
  revision: number,
  snapshotId: string,
  criterionIds: string[],
  key: string,
) {
  return request(
    `${path(id)}/verify`,
    {
      expectedContractRevision: revision,
      expectedCandidateSnapshotId: snapshotId,
      criterionIds,
    },
    key,
  );
}
export function assessVerification(
  id: string,
  v: Verification,
  verdict: string,
  reason: string,
  key: string,
) {
  return request(
    `${path(id)}/human-assessments`,
    {
      verificationId: v.id,
      verdict,
      rationale: { text: reason, media: [] },
      evidenceCitations:
        v.result?.findings.flatMap((f) => f.evidenceCitations) ?? [],
    },
    key,
  );
}
export function acceptReviewedCandidate(
  id: string,
  review: ReviewSnapshot,
  key: string,
) {
  return request(
    `${path(id)}/accept`,
    { reviewSnapshotId: review.id, reviewDigest: review.digest },
    key,
  );
}
export async function uploadMaterial(
  id: string,
  file: File,
  carrier: Material["carrier"],
  key: string,
): Promise<Material> {
  const response = await apiFetch(
    `${base}${path(id)}/materials?${new URLSearchParams({ name: file.name, carrier })}`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": key,
      },
      body: file,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
