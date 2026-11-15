/** Images the Workspace file panel may show inline. */
export const inlineImagePreviewMaxBytes = 20 * 1024 * 1024;

const imageTypesByExtension = new Map<string, readonly string[]>([
  ["avif", ["image/avif"]],
  ["bmp", ["image/bmp"]],
  ["gif", ["image/gif"]],
  ["ico", ["image/x-icon", "image/vnd.microsoft.icon"]],
  ["jpeg", ["image/jpeg"]],
  ["jpg", ["image/jpeg"]],
  ["png", ["image/png"]],
  ["svg", ["image/svg+xml"]],
  ["webp", ["image/webp"]],
]);

export function imagePreviewExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isInlineImageCandidate(path: string): boolean {
  return imageTypesByExtension.has(imagePreviewExtension(path));
}

/** The MIME essence only, lowercased, without a charset or other parameters. */
export function imageMimeEssence(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export type InlineImageDecision =
  | { kind: "preview" }
  | { kind: "too-large"; size: number }
  | { kind: "not-image" };

/**
 * The server's MIME must confirm the extension before the browser decodes the
 * image. This keeps a renamed binary from becoming a broken image element.
 */
export function decideInlineImage(
  path: string,
  size: number,
  contentType: string,
): InlineImageDecision {
  const allowed = imageTypesByExtension.get(imagePreviewExtension(path));
  const mimeType = imageMimeEssence(contentType);
  if (!allowed?.includes(mimeType)) return { kind: "not-image" };
  if (!Number.isFinite(size) || size < 0) return { kind: "not-image" };
  if (size > inlineImagePreviewMaxBytes) {
    return { kind: "too-large", size };
  }
  return { kind: "preview" };
}
