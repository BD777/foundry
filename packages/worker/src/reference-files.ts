import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { identifier } from "./execution-storage.js";

const imageTypes = ["image/png", "image/jpeg", "image/gif"];
const textTypes = ["text/plain", "application/json"];

/** Whether a reference material can be handed to an agent as files. */
export function readableReferenceType(mimeType: string): boolean {
  return (
    imageTypes.includes(mimeType) ||
    textTypes.includes(mimeType) ||
    mimeType === "application/pdf"
  );
}

/**
 * A reference material as a read-only file in `directory`, as it is: agents
 * read images, text and PDFs with their own tools.
 */
export function referenceFile(
  directory: string,
  material: { id: string; mimeType: string },
  name: string,
  bytes: Buffer,
): ChatAttachment {
  const path = resolve(directory, identifier(material.id));
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 });
  return {
    id: material.id,
    name,
    path,
    mimeType: material.mimeType,
    size: bytes.length,
    kind: imageTypes.includes(material.mimeType) ? "image" : "file",
  };
}
