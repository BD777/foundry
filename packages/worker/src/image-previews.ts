/** Small, bounded derivatives; original attachments are never changed. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AttachmentError,
  readAttachmentImageChunk,
} from "./workspace-attachments.js";

export type ImageVariant = "preview" | "placeholder";
export const imagePreviewBudget = 40 * 1024;
const cache = new Map<string, { data: Buffer; mimeType: string }>();
const pending = new Map<
  string,
  Promise<{ data: Buffer; mimeType: string } | undefined>
>();
const failedUntil = new Map<string, number>();
const missingToolsUntil = new Map<string, number>();
const negativeCacheMs = 5 * 60 * 1000;
function rememberFailure(key: string) {
  failedUntil.set(key, Date.now() + negativeCacheMs);
  while (failedUntil.size > 128)
    failedUntil.delete(failedUntil.keys().next().value!);
}
let cacheBytes = 0;
let running = 0;
const waiting: (() => void)[] = [];

async function renderTool(
  command: string,
  args: string[],
  timeoutMs = 2000,
): Promise<Buffer | undefined> {
  const toolKey = command + "\0" + process.env.PATH;
  if ((missingToolsUntil.get(toolKey) || 0) > Date.now()) return undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const done = (result: Buffer | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(undefined, new Error("image preview renderer is busy; retry"));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        done(undefined);
      } else chunks.push(data);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        missingToolsUntil.set(toolKey, Date.now() + negativeCacheMs);
        while (missingToolsUntil.size > 16)
          missingToolsUntil.delete(missingToolsUntil.keys().next().value!);
      }
      done(undefined);
    });
    child.once("close", (code) =>
      done(code === 0 ? Buffer.concat(chunks) : undefined),
    );
  });
}
async function render(
  path: string,
  variant: ImageVariant,
  header: Buffer,
): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  const deadline = Date.now() + 2500;
  const nativeSide =
    header.length >= 24 &&
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? Math.max(header.readUInt32BE(16), header.readUInt32BE(20))
      : undefined;
  let produced = false;
  try {
    const ffmpeg = "ffmpeg";
    const budget = variant === "placeholder" ? 2048 : imagePreviewBudget;
    const sizes: [number, number][] =
      variant === "placeholder"
        ? [
            [96, 10],
            [64, 12],
          ]
        : [
            [1000, 6],
            [800, 7],
            [640, 8],
            [480, 9],
            [320, 12],
            [240, 14],
          ];
    if (ffmpeg) {
      // Older system ffmpeg builds may lack WebP. JPEG remains a portable fallback.
      for (const codec of ["libwebp", "mjpeg"]) {
        let smallest: Buffer | undefined;
        let sideLimit = Infinity;
        for (const [side, q] of sizes) {
          if (Date.now() >= deadline) {
            if (produced)
              throw new Error("image preview preparation is busy; retry");
            return undefined;
          }
          const renderSide = Math.max(16, Math.min(side, sideLimit));
          const output = await renderTool(
            ffmpeg,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-threads",
              "1",
              "-i",
              path,
              "-vf",
              `scale='min(${renderSide},iw)':'min(${renderSide},ih)':force_original_aspect_ratio=decrease`,
              "-frames:v",
              "1",
              "-c:v",
              codec,
              "-threads",
              "1",
              ...(codec === "libwebp"
                ? ["-quality", "70"]
                : ["-q:v", String(q)]),
              "-f",
              "image2pipe",
              "pipe:1",
            ],
            Math.min(1500, Math.max(20, deadline - Date.now())),
          );
          if (!output?.length) break;
          produced = true;
          // Encoded size predicts the next scale: do not repeatedly encode
          // the same native dimensions, or work through every size on noise.
          sideLimit = Math.max(
            16,
            Math.floor(
              Math.min(renderSide, nativeSide || renderSide) *
                Math.sqrt(budget / output.length) *
                0.9,
            ),
          );
          if (!smallest || output.length < smallest.length) smallest = output;
          if (output.length <= budget)
            return {
              data: output,
              mimeType: codec === "libwebp" ? "image/webp" : "image/jpeg",
            };
        }
        if (smallest && smallest.length <= budget)
          return {
            data: smallest,
            mimeType: codec === "libwebp" ? "image/webp" : "image/jpeg",
          };
      }
    }
    // macOS ships sips even when no optional image tools are installed.
    const sips = process.platform === "darwin" ? "sips" : undefined;
    if (sips) {
      const dir = mkdtempSync(join(tmpdir(), "foundry-image-preview-"));
      try {
        const output = join(dir, "preview.jpg");
        for (const [side] of sizes) {
          const ran = await renderTool(sips, [
            "-Z",
            String(side),
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "70",
            path,
            "--out",
            output,
          ]);
          if (ran) {
            const data = readFileSync(output);
            if (data.length <= budget) return { data, mimeType: "image/jpeg" };
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (produced) throw new Error("bounded image preview unavailable; retry");
    return undefined;
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export async function readAttachmentPreviewChunk(
  input: Parameters<typeof readAttachmentImageChunk>[0],
  variant: ImageVariant,
) {
  const original = readAttachmentImageChunk({ ...input, offset: 0 });
  const budget = variant === "placeholder" ? 2048 : imagePreviewBudget;
  if (original.size <= budget) return readAttachmentImageChunk(input);
  const key = `${original.realPath}\0${original.revision}\0${variant}`;
  let preview = cache.get(key);
  if (preview) {
    cache.delete(key);
    cache.set(key, preview);
  } else if ((failedUntil.get(key) || 0) <= Date.now()) {
    let work = pending.get(key);
    if (!work && pending.size < 8) {
      work = render(original.realPath, variant, original.data).catch(
        () => undefined,
      );
      pending.set(key, work);
      work.finally(() => pending.delete(key)).catch(() => {});
    }
    preview = await work;
    if (!preview) rememberFailure(key);
    if (preview && !cache.has(key)) {
      cache.set(key, preview);
      cacheBytes += preview.data.length;
      while (cache.size > 128 || cacheBytes > 64 * 1024 * 1024) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.data.length;
        cache.delete(oldest);
      }
    }
  }
  const current = readAttachmentImageChunk({ ...input, offset: 0 });
  if (
    current.revision !== original.revision ||
    current.realPath !== original.realPath
  )
    throw new AttachmentError(
      "changed",
      "image changed while preparing preview",
    );
  // Unsupported/malformed images retain the existing original read behaviour.
  if (!preview || preview.data.length >= original.size) {
    if (variant === "placeholder")
      throw new AttachmentError(
        "unsupported",
        "tiny image preview unavailable",
      );
    return readAttachmentImageChunk(input);
  }
  return {
    ...original,
    size: preview.data.length,
    mimeType: preview.mimeType,
    data: preview.data.subarray(
      input.offset,
      input.offset + Math.min(input.chunkBytes ?? 64 * 1024, 64 * 1024),
    ),
  };
}
