import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import type { EvidenceWorkerResult } from "@foundry/protocol";
import {
  atomicEvidenceFile,
  EvidenceStore,
  MATERIAL_LIMIT,
} from "./evidence-store.js";
import { identifier } from "./execution-storage.js";

interface UploadLease {
  taskId: string;
  workspaceId: string;
  issueId: string;
  updatedAt: string;
}
const uploadLifetimeMs = 24 * 60 * 60 * 1000;

function uploadPaths(store: EvidenceStore, taskId: string) {
  const base = resolve(store.root, "outbox", identifier(taskId));
  return {
    bytes: `${base}.upload`,
    lease: `${base}.upload.json`,
    intent: `${base}.intent.json`,
    result: `${base}.result.json`,
  };
}
function ordinaryFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error("unsafe_upload_file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Called under the Issue evidence lock; sealed Material files are never removed. */
export function expireIncompleteUploads(
  store: EvidenceStore,
  now = Date.now(),
): void {
  const outbox = resolve(store.root, "outbox");
  for (const name of readdirSync(outbox)) {
    if (!name.endsWith(".upload.json")) continue;
    const leasePath = resolve(outbox, name);
    if (!ordinaryFile(leasePath)) continue;
    let lease: UploadLease;
    try {
      lease = JSON.parse(readFileSync(leasePath, "utf8"));
    } catch {
      continue; // Unknown ownership is never permission to delete.
    }
    if (
      lease.workspaceId !== store.workspaceId ||
      lease.issueId !== store.issueId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(lease.taskId) ||
      name !== `${lease.taskId}.upload.json`
    )
      continue;
    const updatedAt = Date.parse(lease.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < uploadLifetimeMs)
      continue;
    const paths = uploadPaths(store, lease.taskId);
    // A seal may have been interrupted. Keep its bytes for diagnosis/recovery.
    if (existsSync(paths.intent) || existsSync(paths.result)) continue;
    if (ordinaryFile(paths.bytes)) unlinkSync(paths.bytes);
    unlinkSync(leasePath);
  }
}

/** Finished retries compare the original Material, never create another upload. */
export function appendEvidenceUpload(
  store: EvidenceStore,
  taskId: string,
  offset: number,
  bytesBase64: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    bytesBase64.length > 360000
  )
    throw new Error("invalid_upload_chunk");
  const bytes = Buffer.from(bytesBase64, "base64");
  if (bytes.toString("base64") !== bytesBase64)
    throw new Error("invalid_upload_encoding");
  if (offset + bytes.length > MATERIAL_LIMIT)
    throw new Error("material_too_large");
  const paths = uploadPaths(store, taskId);
  if (ordinaryFile(paths.result)) {
    const receipt = JSON.parse(
      readFileSync(paths.result, "utf8"),
    ) as EvidenceWorkerResult;
    if (receipt.error || receipt.materials?.length !== 1)
      throw new Error("upload_receipt_not_replayable");
    const original = store.readMaterial(receipt.materials[0]!.id);
    if (
      offset + bytes.length > original.length ||
      !original.subarray(offset, offset + bytes.length).equals(bytes)
    )
      throw new Error("idempotency_conflict: uploaded bytes changed");
    return;
  }
  if (existsSync(paths.intent))
    throw new Error("task_outcome_unknown: retain upload for recovery");
  if (ordinaryFile(paths.lease)) {
    const lease = JSON.parse(readFileSync(paths.lease, "utf8")) as UploadLease;
    if (
      lease.taskId !== taskId ||
      lease.issueId !== store.issueId ||
      lease.workspaceId !== store.workspaceId
    )
      throw new Error("upload_scope_mismatch");
  }
  const length = ordinaryFile(paths.bytes) ? lstatSync(paths.bytes).size : 0;
  if (length !== offset) {
    if (
      length < offset + bytes.length ||
      !readFileSync(paths.bytes)
        .subarray(offset, offset + bytes.length)
        .equals(bytes)
    )
      throw new Error("upload_offset_conflict");
  } else {
    appendFileSync(paths.bytes, bytes, { mode: 0o600 });
  }
  atomicEvidenceFile(
    paths.lease,
    JSON.stringify({
      taskId,
      workspaceId: store.workspaceId,
      issueId: store.issueId,
      updatedAt: new Date().toISOString(),
    } satisfies UploadLease),
  );
}

/** Only invoked after a durable successful seal receipt exists. */
export function finishEvidenceUpload(
  store: EvidenceStore,
  taskId: string,
): void {
  const paths = uploadPaths(store, taskId);
  if (!ordinaryFile(paths.result)) throw new Error("upload_receipt_missing");
  for (const path of [paths.bytes, paths.lease]) {
    if (ordinaryFile(path)) unlinkSync(path);
  }
}
