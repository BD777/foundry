import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  ActorRef,
  CarrierKind,
  EvidenceRecord,
  Material,
} from "@foundry/protocol";
import { validateEvidenceModel } from "@foundry/protocol";
import { ExecutionStore, identifier, within } from "./execution-storage.js";

export const MATERIAL_LIMIT = 100 * 1024 * 1024;
export const INLINE_IMAGE_LIMIT = 25 * 1024 * 1024;
export function digestBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function digestObject(value: unknown): string {
  const text = (v: unknown): string =>
    JSON.stringify(v)
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
  // Emit keys directly: rebuilding an object would reorder numeric-looking keys.
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map((item) => stable(item === undefined ? null : item)).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.entries(v)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .map(([key, value]) => `${text(key)}:${stable(value)}`)
            .join(",")}}`
        : text(v);
  return digestBytes(stable(value));
}
export function evidenceRecord(
  workspaceId: string,
  issueId: string,
  actor: ActorRef,
  prefix: string,
): EvidenceRecord {
  return {
    schemaVersion: 1,
    id: `${prefix}_${randomUUID()}`,
    workspaceId,
    issueId,
    createdAt: new Date().toISOString(),
    createdBy: actor,
  };
}
export function atomicEvidenceFile(
  path: string,
  bytes: Uint8Array | string,
): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(resolve(path, ".."), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function detectedMime(bytes: Buffer): string {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.subarray(0, 6).toString() === "GIF89a" ||
    bytes.subarray(0, 6).toString() === "GIF87a"
  )
    return "image/gif";
  if (bytes.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  try {
    JSON.parse(bytes.toString("utf8"));
    return "application/json";
  } catch {
    /* Not JSON. */
  }
  const text = bytes.toString("utf8");
  if (!text.includes("\0") && Buffer.from(text).equals(bytes))
    return "text/plain";
  return "application/octet-stream";
}

/** Private immutable bytes, outside worktrees, provider scratch and run cleanup. */
export class EvidenceStore {
  readonly root: string;
  constructor(
    readonly workspaceId: string,
    readonly issueId: string,
    readonly deviceId: string,
    readonly actor: ActorRef,
    store = new ExecutionStore(),
  ) {
    this.root = resolve(
      store.executionRoot,
      identifier(workspaceId),
      "evidence-store",
    );
    for (const path of [
      resolve(store.executionRoot, identifier(workspaceId)),
      this.root,
    ]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("Evidence storage root must not be a symlink");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
    for (const name of [
      "materials",
      "evidence",
      "candidate-snapshots",
      "verification-inputs",
      "verifier-output",
      "outbox",
    ]) {
      const path = resolve(this.root, name);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink())
        throw new Error("Evidence storage must not be a symlink");
      chmodSync(path, 0o700);
    }
  }
  record(prefix: string): EvidenceRecord {
    return evidenceRecord(this.workspaceId, this.issueId, this.actor, prefix);
  }
  sealMaterial(
    name: string,
    carrier: CarrierKind,
    bytes: Buffer,
    redaction: Material["redaction"] = { status: "none" },
  ): Material {
    if (bytes.length > MATERIAL_LIMIT)
      throw new Error("material_too_large: 100 MiB limit");
    const record = this.record("mat");
    const material: Material = {
      ...record,
      name,
      carrier,
      mimeType: detectedMime(bytes),
      byteSize: bytes.length,
      digest: digestBytes(bytes),
      storageDeviceId: this.deviceId,
      capturedAt: record.createdAt,
      redaction,
      previewMaterialIds: [],
      availability: "available",
      availabilityCheckedAt: record.createdAt,
    };
    const path = this.materialPath(material.id);
    atomicEvidenceFile(path, bytes);
    if (digestBytes(this.readBytes(path)) !== material.digest)
      throw new Error("material_corrupt");
    this.sealRecord("materials", material, "Material");
    return material;
  }
  materialPath(id: string): string {
    return resolve(this.root, "materials", `${identifier(id)}.bin`);
  }
  private readBytes(path: string): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  getMaterial(id: string): Material {
    const material = this.readRecord<Material>("materials", id);
    if (material.availability === "deleted") return material;
    const path = this.materialPath(id);
    material.availability = !existsSync(path)
      ? "missing"
      : digestBytes(this.readBytes(path)) === material.digest
        ? "available"
        : "corrupt";
    material.availabilityCheckedAt = new Date().toISOString();
    return material;
  }
  readMaterial(id: string): Buffer {
    const material = this.getMaterial(id);
    if (material.availability !== "available")
      throw new Error(`material_${material.availability}`);
    return this.readBytes(this.materialPath(id));
  }
  sealRecord(
    directory: string,
    record: EvidenceRecord,
    model?: Parameters<typeof validateEvidenceModel>[0],
  ): void {
    this.assertScope(record);
    if (model) {
      const errors = validateEvidenceModel(model, record);
      if (errors.length) throw new Error(errors.join("; "));
    }
    const path = this.recordPath(directory, record.id);
    if (existsSync(path)) {
      if (
        digestObject(JSON.parse(readFileSync(path, "utf8"))) !==
        digestObject(record)
      )
        throw new Error("immutable_record_conflict");
      return;
    }
    atomicEvidenceFile(path, JSON.stringify(record));
  }
  readRecord<T extends EvidenceRecord>(directory: string, id: string): T {
    const value = JSON.parse(
      this.readBytes(this.recordPath(directory, id)).toString(),
    ) as T;
    this.assertScope(value);
    return value;
  }
  listRecords<T extends EvidenceRecord>(directory: string): T[] {
    return readdirSync(resolve(this.root, identifier(directory)))
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(
            this.readBytes(resolve(this.root, directory, name)).toString(),
          ) as T,
      )
      .filter(
        (record) =>
          record.issueId === this.issueId &&
          record.workspaceId === this.workspaceId,
      );
  }
  private recordPath(directory: string, id: string): string {
    const path = resolve(
      this.root,
      identifier(directory),
      `${identifier(id)}.json`,
    );
    if (!within(this.root, path)) throw new Error("invalid evidence path");
    return path;
  }
  private assertScope(record: EvidenceRecord): void {
    if (
      record.workspaceId !== this.workspaceId ||
      record.issueId !== this.issueId
    )
      throw new Error("cross_issue_reference");
  }
}
