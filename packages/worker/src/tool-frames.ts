// Screenshots tools already produce, kept per step (DEV-075). An MCP image
// result (Playwright MCP, Foundry's computer_use) or a file a browser CLI
// reports is copied into the workspace's .foundry/attachments/frames/<session>
// and named by a session event that carries only the reference. Nothing new is
// captured: only what the tool returned to the model. A browser CLI's own
// output stream or command log is never read here — only the image bytes of a
// file it reports.
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  sessionToolFrameLimits,
  type SessionToolFrame,
  type SessionToolFrameSource,
} from "@bd777/foundry-protocol";

/** Bigger images are skipped: the image route reads at most this much. */
export const maxToolFrameBytes = 8 * 1024 * 1024;
/** Images one tool result may contribute. */
const maxFramesPerResult = 4;

/** One image a tool result carried, before it is stored. */
export interface ToolFrameCandidate {
  /** Inline bytes (an MCP image block). */
  data?: Buffer;
  /** A file the tool reported writing. */
  file?: string;
  source: SessionToolFrameSource;
}

/** A tool call's result and the images it carried. */
export interface ToolFrameResult {
  callId: string;
  tool: string;
  candidates: ToolFrameCandidate[];
}

/**
 * Redaction hook point (not used yet). A later phase may blank regions of a
 * frame before it is stored; returning undefined drops the frame. Frames are
 * kept as the model saw them until then.
 */
export type ToolFrameRedactor = (
  frame: Pick<SessionToolFrame, "callId" | "tool" | "source">,
  data: Buffer,
) => Buffer | undefined;

interface ImageInfo {
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
}

/** The image's type and size from its header, or undefined for a non-image. */
export function sniffImage(data: Buffer): ImageInfo | undefined {
  if (
    data.length >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return {
      mimeType: "image/png",
      extension: "png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // Walk the markers to the first start-of-frame.
    let offset = 2;
    while (offset + 9 < data.length && data[offset] === 0xff) {
      const marker = data[offset + 1]!;
      const length = data.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          mimeType: "image/jpeg",
          extension: "jpg",
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    data.length >= 30 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    const chunk = data.subarray(12, 16).toString("latin1");
    const info: ImageInfo = { mimeType: "image/webp", extension: "webp" };
    if (chunk === "VP8X")
      return {
        ...info,
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    if (chunk === "VP8 ")
      return {
        ...info,
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return {
        ...info,
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return info;
  }
  if (
    data.length >= 10 &&
    /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))
  )
    return {
      mimeType: "image/gif",
      extension: "gif",
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  return undefined;
}

/** The source a tool's name implies for an image it returned inline. */
export function toolFrameSource(tool: string): SessionToolFrameSource {
  const name = tool.toLowerCase();
  if (name.includes("operate_resource") || name.includes("computer"))
    return "computer-use";
  if (name.includes("playwright")) return "playwright-mcp";
  return "mcp";
}

const agentBrowserSaved =
  /Screenshot saved to\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/g;
const playwrightLink = /\[Screenshot of [^\]\n]*\]\(([^)\n]+)\)/g;
const imageExtension = /\.(?:png|jpe?g|webp|gif)$/i;
// Terminal colors around the path a CLI prints.
// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;

/**
 * Screenshot files a browser CLI reported in its text output: agent-browser
 * prints "Screenshot saved to <path>", playwright-cli (and Playwright MCP
 * without image results) a "[Screenshot of …](<path>)" link, relative to the
 * working directory.
 */
export function screenshotFilesInText(
  text: string,
  cwd: string,
  tool: string,
): ToolFrameCandidate[] {
  if (!text.includes("Screenshot")) return [];
  const plain = text.replace(ansi, "");
  const found: ToolFrameCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string, source: SessionToolFrameSource) => {
    const path = raw.trim().replace(/[.,;:]+$/, "");
    if (!imageExtension.test(path)) return;
    const file = isAbsolute(path) ? path : resolve(cwd, path);
    if (seen.has(file)) return;
    seen.add(file);
    found.push({ file, source });
  };
  for (const match of plain.matchAll(agentBrowserSaved))
    add(match[1] ?? match[2] ?? match[3] ?? "", "agent-browser");
  const mcp = /^mcp__|\./.test(tool) && !/^bash$/i.test(tool);
  for (const match of plain.matchAll(playwrightLink))
    add(match[1] ?? "", mcp ? toolFrameSource(tool) : "playwright-cli");
  return found.slice(0, maxFramesPerResult);
}

function imageBlockData(block: Record<string, unknown>): Buffer | undefined {
  if (block.type !== "image") return undefined;
  // Claude: { source: { type: "base64", data } }; MCP: { data, mimeType }.
  const source = block.source as Record<string, unknown> | undefined;
  const data =
    source && source.type === "base64" && typeof source.data === "string"
      ? source.data
      : typeof block.data === "string"
        ? block.data
        : undefined;
  if (!data) return undefined;
  // Bigger than any frame we keep: not decoded.
  if (data.length > (maxToolFrameBytes * 4) / 3 + 4) return undefined;
  return Buffer.from(data, "base64");
}

/** Images inline in a tool result, else the screenshot files its text names. */
function resultCandidates(
  content: unknown,
  tool: string,
  cwd: string,
): ToolFrameCandidate[] {
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  const images: ToolFrameCandidate[] = [];
  let text = "";
  for (const value of blocks) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    const data = imageBlockData(block);
    if (data) images.push({ data, source: toolFrameSource(tool) });
    else if (block.type === "text" && typeof block.text === "string")
      text += `${block.text}\n`;
  }
  if (images.length > 0) return images.slice(0, maxFramesPerResult);
  return screenshotFilesInText(text, cwd, tool);
}

/**
 * The images in a Claude SDK message's tool results. `tools` names each
 * call (by id) the turn saw start; a result of an unknown call is skipped.
 */
export function claudeToolResultFrames(
  message: unknown,
  tools: ReadonlyMap<string, string>,
  cwd: string,
): ToolFrameResult[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  if (record.type !== "user") return [];
  const content = (record.message as Record<string, unknown> | undefined)
    ?.content;
  if (!Array.isArray(content)) return [];
  const results: ToolFrameResult[] = [];
  for (const value of content) {
    const block = value as Record<string, unknown> | undefined;
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string")
      continue;
    const tool = tools.get(block.tool_use_id);
    if (!tool) continue;
    const candidates = resultCandidates(block.content, tool, cwd);
    if (candidates.length > 0)
      results.push({ callId: block.tool_use_id, tool, candidates });
  }
  return results;
}

/** The images of a finished Codex MCP call or command (item.completed). */
export function codexToolCallFrames(
  event: unknown,
  cwd: string,
): ToolFrameResult[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  if (record.type !== "item.completed") return [];
  const item = record.item as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== "string") return [];
  if (item.type === "mcp_tool_call") {
    const tool = `${typeof item.server === "string" ? item.server : "mcp"}.${typeof item.tool === "string" ? item.tool : "tool"}`;
    const result = item.result as Record<string, unknown> | undefined;
    const candidates = resultCandidates(result?.content, tool, cwd);
    return candidates.length > 0 ? [{ callId: item.id, tool, candidates }] : [];
  }
  if (
    item.type === "command_execution" &&
    typeof item.aggregated_output === "string"
  ) {
    const candidates = screenshotFilesInText(
      item.aggregated_output,
      cwd,
      "shell",
    );
    return candidates.length > 0
      ? [{ callId: item.id, tool: "shell", candidates }]
      : [];
  }
  return [];
}

function readImageFile(path: string): Buffer | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxToolFrameBytes)
      return undefined;
    const data = Buffer.alloc(stats.size);
    const fd = openSync(path, "r");
    try {
      let offset = 0;
      while (offset < data.length) {
        const read = readSync(fd, data, offset, data.length - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      return offset === data.length ? data : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Where a session's frames live in its workspace. */
export function toolFramesDirectory(
  workspacePath: string,
  sessionId: string,
): string {
  return join(workspacePath, ".foundry", "attachments", "frames", sessionId);
}

/**
 * Which of a session's frames (oldest first) stay: the newest that fit both
 * limits together; once one does not fit, it and every older one go.
 */
export function retainedToolFrames<T extends { bytes: number }>(
  frames: readonly T[],
  limits: { count: number; bytes: number } = sessionToolFrameLimits,
): { kept: T[]; dropped: T[] } {
  let count = 0;
  let bytes = 0;
  let cut = frames.length;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const size = Math.max(0, frames[index]!.bytes);
    if (count + 1 > limits.count || bytes + size > limits.bytes) break;
    count += 1;
    bytes += size;
    cut = index;
  }
  return { kept: frames.slice(cut), dropped: frames.slice(0, cut) };
}

/** Removes the session's oldest frame files beyond the limits. */
function pruneFrameFiles(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => !name.startsWith("."));
  } catch {
    return;
  }
  // Names begin with a fixed-width capture time: name order is age order.
  names.sort();
  const files = names.flatMap((name) => {
    try {
      return [{ name, bytes: statSync(join(directory, name)).size }];
    } catch {
      return [];
    }
  });
  for (const file of retainedToolFrames(files).dropped) {
    try {
      unlinkSync(join(directory, file.name));
    } catch {
      /* Already gone. */
    }
  }
}

/** Stores the images of one session's tool results as frames. */
export class SessionToolFrames {
  constructor(
    private readonly options: {
      workspacePath: string;
      sessionId: string;
      inputId?: string;
      redact?: ToolFrameRedactor;
      now?: () => number;
    },
  ) {}

  /** The frames stored for a result, in its order; failures are skipped. */
  store(result: ToolFrameResult): SessionToolFrame[] {
    const directory = toolFramesDirectory(
      this.options.workspacePath,
      this.options.sessionId,
    );
    const frames: SessionToolFrame[] = [];
    for (const candidate of result.candidates) {
      let data = candidate.data ?? readImageFile(candidate.file ?? "");
      if (!data || data.length === 0 || data.length > maxToolFrameBytes)
        continue;
      const reference = {
        callId: result.callId,
        tool: result.tool,
        source: candidate.source,
      };
      if (this.options.redact) data = this.options.redact(reference, data);
      if (!data) continue;
      const info = sniffImage(data);
      if (!info) continue;
      const now = this.options.now?.() ?? Date.now();
      const id = `frm_${now.toString(36)}${randomBytes(5).toString("hex")}`;
      const path = join(
        directory,
        `${String(now).padStart(15, "0")}-${id}.${info.extension}`,
      );
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, data, { mode: 0o600 });
      } catch {
        continue;
      }
      frames.push({
        id,
        ...reference,
        path,
        mimeType: info.mimeType,
        bytes: data.length,
        ...(info.width && info.height
          ? { width: info.width, height: info.height }
          : {}),
        capturedAt: new Date(now).toISOString(),
        ...(this.options.inputId ? { inputId: this.options.inputId } : {}),
      });
    }
    if (frames.length > 0) pruneFrameFiles(directory);
    return frames;
  }
}
