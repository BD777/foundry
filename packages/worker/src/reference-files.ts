import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { identifier } from "./execution-storage.js";
import { extractPdfText, pdfTextDocument } from "./pdf-text.js";

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
 * A reference material as read-only files in `directory`. A PDF comes twice:
 * the document itself (Claude reads PDFs) and its extracted text beside it
 * (for runtimes that cannot, such as Codex), named so the agent knows the
 * text leaves out layout and images.
 */
export async function referenceFiles(
  directory: string,
  material: { id: string; mimeType: string },
  name: string,
  bytes: Buffer,
): Promise<{ original: ChatAttachment; text?: ChatAttachment }> {
  const path = resolve(directory, identifier(material.id));
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 });
  const original: ChatAttachment = {
    id: material.id,
    name,
    path,
    mimeType: material.mimeType,
    size: bytes.length,
    kind: imageTypes.includes(material.mimeType) ? "image" : "file",
  };
  if (material.mimeType !== "application/pdf") return { original };
  const textPath = `${path}.txt`;
  if (!existsSync(textPath)) {
    let text: string;
    try {
      text = pdfTextDocument(name, await extractPdfText(bytes));
    } catch (error) {
      text = `No text could be extracted from ${name} (${error instanceof Error ? error.message : String(error)}). Read the PDF itself.\n`;
    }
    writeFileSync(textPath, text, { mode: 0o400 });
  }
  return {
    original,
    text: {
      id: `${material.id}.txt`,
      name: `Text extracted from ${name} (layout and images not included)`,
      path: textPath,
      mimeType: "text/plain",
      size: statSync(textPath).size,
      kind: "file",
    },
  };
}
