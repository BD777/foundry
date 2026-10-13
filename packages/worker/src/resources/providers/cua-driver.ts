// The computer_use provider: trycua's cua-driver (MIT), driven as a stdio
// MCP server (`cua-driver mcp`, a proxy to the CuaDriver.app daemon, which
// holds the macOS grants). One process per lease: a pixel action needs a
// screenshot of its window earlier in the same MCP session.
//
// Foundry's operations (computerUseOperations) map one to one onto
// cua-driver tools of v0.34.1 and keep its argument names. Coordinates are
// pixels of the window's latest screenshot; cua-driver converts them to
// screen points, so nothing here rescales them. Tool schemas change between
// releases: a tool missing from tools/list is reported as
// backend_unsupported.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cuaDriverBackend,
  type ResourceAction,
  type ResourceActionResult,
  type ResourceImage,
} from "@bd777/foundry-protocol";
import { cuaDriverEnv, resolveCuaDriverBinary } from "../cua-driver-host.js";
import { execBounded, isExecutableFile } from "../exec.js";
import {
  ProviderError,
  type ProviderSession,
  type ResourceProvider,
} from "../provider.js";
import { McpError, McpStdioClient, type McpToolResult } from "./mcp-stdio.js";

/** The longest edge of a screenshot Foundry asks for (and the default). */
export const maxImageDimension = 1280;
/** The largest encoded image an action may return. */
export const maxImageBytes = 2 * 1024 * 1024;
/** The most text an action returns. */
export const maxTextBytes = 200 * 1024;
/** The most of a tool's structured result passed on as JSON text. */
export const maxStructuredBytes = 64 * 1024;
/** The longest wait an action may ask for. */
export const maxWaitMs = 5000;

type ArgSpec =
  | "int"
  | "number"
  | "string"
  | "bool"
  | "strings"
  | "string_or_strings"
  | readonly string[];

interface OpSpec {
  args: Record<string, ArgSpec>;
  required?: string[];
  /** At least one of these groups must be given whole. */
  anyOf?: string[][];
  build(args: Record<string, unknown>): MappedAction;
}

export type MappedAction =
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "wait"; ms: number };

const deliveryMode = ["background", "foreground"] as const;
const target = { pid: "int", window_id: "int" } as const;
const input = { ...target, delivery_mode: deliveryMode } as const;
const pointer = { element_token: "string", x: "number", y: "number" } as const;
const pointed = [["element_token"], ["x", "y"]];

function imageDimension(args: Record<string, unknown>): number {
  const asked = args.max_image_dimension;
  return typeof asked === "number" && asked > 0
    ? Math.min(asked, maxImageDimension)
    : maxImageDimension;
}

const tool =
  (name: string, fixed: Record<string, unknown> = {}) =>
  (args: Record<string, unknown>): MappedAction => ({
    kind: "tool",
    tool: name,
    args: { ...args, ...fixed },
  });

const operations: Record<string, OpSpec> = {
  screenshot: {
    args: { ...target, max_image_dimension: "int" },
    build: (args) =>
      args.pid !== undefined
        ? {
            kind: "tool",
            tool: "get_window_state",
            args: {
              ...args,
              include_screenshot: true,
              include_accessibility_tree: false,
              max_image_dimension: imageDimension(args),
            },
          }
        : {
            kind: "tool",
            tool: "get_desktop_state",
            args: { max_image_dimension: imageDimension(args) },
          },
  },
  get_ui_tree: {
    args: {
      ...target,
      query: "string",
      max_elements: "int",
      max_depth: "int",
      include_screenshot: "bool",
      max_image_dimension: "int",
    },
    required: ["pid", "window_id"],
    build: (args) => ({
      kind: "tool",
      tool: "get_window_state",
      args: {
        ...args,
        include_screenshot: args.include_screenshot ?? false,
        include_accessibility_tree: true,
        max_image_dimension: imageDimension(args),
      },
    }),
  },
  find_elements: {
    args: { ...target, query: "string", max_elements: "int" },
    required: ["pid", "window_id", "query"],
    build: tool("get_window_state", {
      include_screenshot: false,
      include_accessibility_tree: true,
    }),
  },
  list_apps: { args: {}, build: tool("list_apps") },
  list_windows: {
    args: { pid: "int", on_screen_only: "bool" },
    build: tool("list_windows"),
  },
  open_app: {
    args: { bundle_id: "string", name: "string", urls: "strings" },
    anyOf: [["bundle_id"], ["name"]],
    build: tool("launch_app"),
  },
  activate_window: {
    args: target,
    required: ["pid"],
    build: tool("bring_to_front"),
  },
  click: {
    args: {
      ...input,
      ...pointer,
      button: ["left", "right", "middle"],
      count: "int",
      modifier: "strings",
    },
    anyOf: pointed,
    build: tool("click"),
  },
  double_click: {
    args: { ...input, ...pointer },
    anyOf: pointed,
    build: tool("double_click"),
  },
  right_click: {
    args: { ...input, ...pointer, modifier: "string_or_strings" },
    anyOf: pointed,
    build: tool("right_click"),
  },
  type_text: {
    args: { ...input, text: "string", element_token: "string" },
    required: ["text"],
    build: tool("type_text"),
  },
  key: {
    args: {
      ...input,
      key: "string",
      modifiers: "strings",
      element_token: "string",
    },
    required: ["key"],
    build: tool("press_key"),
  },
  hotkey: {
    args: { ...input, keys: "strings" },
    required: ["keys"],
    build: tool("hotkey"),
  },
  scroll: {
    args: {
      ...input,
      ...pointer,
      direction: ["up", "down", "left", "right"],
      amount: "int",
      by: ["line", "page"],
    },
    required: ["direction"],
    build: tool("scroll"),
  },
  drag: {
    // On macOS cua-driver drags only in the foreground, on a window.
    args: {
      ...target,
      from_x: "number",
      from_y: "number",
      to_x: "number",
      to_y: "number",
      duration_ms: "int",
      button: ["left", "right", "middle"],
    },
    required: ["from_x", "from_y", "to_x", "to_y", "window_id"],
    build: tool("drag", { delivery_mode: "foreground" }),
  },
  set_value: {
    args: { ...input, value: "string", element_token: "string" },
    required: ["value"],
    build: tool("set_value"),
  },
  screen_size: { args: {}, build: tool("get_screen_size") },
  wait: {
    args: { ms: "int" },
    required: ["ms"],
    build: (args) => ({
      kind: "wait",
      ms: Math.min(Math.max(args.ms as number, 0), maxWaitMs),
    }),
  },
};

/** The operations this provider knows, in its own order. */
export const cuaDriverOperations = Object.keys(operations);

/**
 * A Foundry action as the cua-driver tool call (or local wait) it is, or a
 * ProviderError (unknown_op, invalid_args).
 */
export function mapComputerUseAction(action: ResourceAction): MappedAction {
  const spec = Object.hasOwn(operations, action.op)
    ? operations[action.op]
    : undefined;
  if (!spec)
    throw new ProviderError(
      "unknown_op",
      `${action.op} is not a computer_use operation (known: ${cuaDriverOperations.join(", ")})`,
    );
  const args = action.args ?? {};
  if (typeof args !== "object" || Array.isArray(args))
    throw new ProviderError(
      "invalid_args",
      `${action.op}: args must be an object`,
    );
  const given: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const type = spec.args[name];
    if (!type)
      throw new ProviderError(
        "invalid_args",
        `${action.op} takes no ${name}${Object.keys(spec.args).length ? ` (it takes ${Object.keys(spec.args).join(", ")})` : ""}`,
      );
    const problem = checkArg(value, type);
    if (problem)
      throw new ProviderError(
        "invalid_args",
        `${action.op}: ${name} ${problem}`,
      );
    given[name] = value;
  }
  for (const name of spec.required ?? [])
    if (!(name in given))
      throw new ProviderError("invalid_args", `${action.op} needs ${name}`);
  if (
    spec.anyOf &&
    !spec.anyOf.some((group) => group.every((name) => name in given))
  )
    throw new ProviderError(
      "invalid_args",
      `${action.op} needs ${spec.anyOf.map((group) => group.join(" and ")).join(", or ")}`,
    );
  if (action.op === "screenshot" && "pid" in given !== "window_id" in given)
    throw new ProviderError(
      "invalid_args",
      "screenshot of a window needs pid and window_id (without both, it is the whole display)",
    );
  if (action.op === "hotkey" && (given.keys as string[]).length < 2)
    throw new ProviderError(
      "invalid_args",
      "hotkey needs at least two keys (one key: use key)",
    );
  return spec.build(given);
}

function checkArg(value: unknown, type: ArgSpec): string | undefined {
  if (Array.isArray(type))
    return typeof value === "string" && type.includes(value)
      ? undefined
      : `must be one of ${type.join(", ")}`;
  const strings = (item: unknown): boolean =>
    Array.isArray(item) && item.every((entry) => typeof entry === "string");
  switch (type) {
    case "int":
      return Number.isInteger(value) ? undefined : "must be an integer";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : "must be a number";
    case "string":
      return typeof value === "string" ? undefined : "must be a string";
    case "bool":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "strings":
      return strings(value) ? undefined : "must be a list of strings";
    case "string_or_strings":
      return typeof value === "string" || strings(value)
        ? undefined
        : "must be a string or a list of strings";
  }
  return undefined;
}

/** Re-encodes a screenshot for sending (JPEG on macOS). */
export type ImageEncoder = (
  image: Buffer,
  mimeType: string,
) => Promise<{ data: Buffer; mimeType: string }>;

/**
 * JPEG at quality 75 with macOS's own sips, in a private temp folder;
 * elsewhere (or without sips) the image stays as it is.
 */
export function sipsJpegEncoder(
  platform: NodeJS.Platform = process.platform,
): ImageEncoder {
  const sips = "/usr/bin/sips";
  return async (image, mimeType) => {
    if (platform !== "darwin" || !isExecutableFile(sips, platform))
      return { data: image, mimeType };
    const folder = await mkdtemp(join(tmpdir(), "foundry-shot-"));
    try {
      const source = join(folder, "in.png");
      const encoded = join(folder, "out.jpg");
      await writeFile(source, image, { mode: 0o600 });
      const run = await execBounded(
        sips,
        [
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "75",
          source,
          "--out",
          encoded,
        ],
        { timeoutMs: 15_000, maxOutputBytes: 16 * 1024 },
      );
      if (run.code !== 0)
        throw new ProviderError(
          "backend_error",
          `could not encode the screenshot: ${run.stderr.trim() || `sips exit ${run.code}`}`,
        );
      return { data: await readFile(encoded), mimeType: "image/jpeg" };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}

/** Width and height from a PNG header, when it is one. */
function pngSize(image: Buffer): { width: number; height: number } | undefined {
  const signature = "89504e470d0a1a0a";
  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== signature)
    return undefined;
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function capText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxTextBytes) return text;
  return `${bytes.subarray(0, maxTextBytes).toString("utf8")}\n[truncated: ${bytes.length} bytes in all]`;
}

/**
 * A tool's `structuredContent` as compact JSON, bounded by `limit` bytes.
 * cua-driver keeps the machine-readable result there and only a summary in
 * its text ("Found 15 window(s)."); see libs/cua-driver/docs/tool-output-format.md
 * in github.com/trycua/cua. `tree_markdown` is left out when the text already
 * carries it, as is the advisory `_note`. Over the limit, the longest arrays
 * are shortened (and say so) so the JSON stays parseable.
 */
export function structuredText(
  structured: Record<string, unknown>,
  shownText: string,
  limit = maxStructuredBytes,
): string {
  const payload: Record<string, unknown> = { ...structured };
  delete payload._note;
  if (
    typeof payload.tree_markdown === "string" &&
    payload.tree_markdown &&
    shownText.includes(payload.tree_markdown)
  )
    delete payload.tree_markdown;
  if (Object.keys(payload).length === 0) return "";
  const size = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(payload) <= limit) return JSON.stringify(payload);
  const arrays = Object.keys(payload)
    .filter((key) => Array.isArray(payload[key]))
    .sort((a, b) => size(payload[b]) - size(payload[a]));
  for (const key of arrays) {
    const all = payload[key] as unknown[];
    let low = 0;
    let high = all.length;
    while (low < high) {
      const keep = Math.ceil((low + high) / 2);
      const trial = {
        ...payload,
        [key]: all.slice(0, keep),
        [`${key}_truncated`]: { returned: keep, total: all.length },
      };
      if (size(trial) <= limit) low = keep;
      else high = keep - 1;
    }
    if (low === all.length) continue;
    payload[key] = all.slice(0, low);
    payload[`${key}_truncated`] = { returned: low, total: all.length };
    if (size(payload) <= limit) return JSON.stringify(payload);
  }
  const json = JSON.stringify(payload);
  return `${Buffer.from(json, "utf8").subarray(0, limit).toString("utf8")}\n[structured result truncated: ${Buffer.byteLength(json, "utf8")} bytes in all; narrow it with pid, query or max_elements]`;
}

/** A cua-driver tool result as a Foundry action result. */
export async function convertToolResult(
  op: string,
  result: McpToolResult,
  encode: ImageEncoder,
  imageLimit = maxImageBytes,
): Promise<ResourceActionResult> {
  const texts: string[] = [];
  const images: ResourceImage[] = [];
  const structured = result.structuredContent ?? {};
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
    if (block.type !== "image" || typeof block.data !== "string") continue;
    const source = Buffer.from(block.data, "base64");
    const encoded = await encode(source, block.mimeType ?? "image/png");
    if (encoded.data.length > imageLimit)
      return {
        op,
        ok: false,
        errorCode: "too_large",
        error: `the screenshot is ${(encoded.data.length / 1048576).toFixed(1)} MB encoded, over the ${imageLimit / 1048576} MB limit; lower max_image_dimension`,
      };
    const size = pngSize(source);
    const snapshot = structured.snapshot_id;
    images.push({
      data: encoded.data.toString("base64"),
      mimeType: encoded.mimeType,
      width: positiveNumber(structured.screenshot_width) ?? size?.width ?? 0,
      height: positiveNumber(structured.screenshot_height) ?? size?.height ?? 0,
      scale: positiveNumber(structured.screenshot_scale) ?? 1,
      frameId:
        images.length === 0 &&
        (typeof snapshot === "string" || typeof snapshot === "number")
          ? String(snapshot)
          : `frame_${randomUUID().slice(0, 12)}`,
    });
  }
  let text = texts.join("\n");
  if (result.structuredContent && !result.isError) {
    const json = structuredText(result.structuredContent, text);
    if (json) text = text ? `${text}\n${json}` : json;
  }
  if (result.isError) {
    const message = text || "cua-driver reported an error";
    return {
      op,
      ok: false,
      // The window has no screenshot in this session (a new session after
      // a reset, or none taken): take one, then act on its pixels.
      errorCode: /screenshot_context_missing/.test(message)
        ? "stale_frame"
        : "backend_error",
      error: capText(message),
    };
  }
  return {
    op,
    ok: true,
    ...(text ? { text: capText(text) } : {}),
    ...(images.length ? { images } : {}),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) return rejectSleep(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectSleep(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How an exception during an action reads as its result. */
function failure(
  op: string,
  error: unknown,
  signal: AbortSignal,
): ResourceActionResult {
  if (signal.aborted && signal.reason instanceof ProviderError)
    return {
      op,
      ok: false,
      errorCode: signal.reason.code,
      error: signal.reason.message,
    };
  if (error instanceof ProviderError)
    return { op, ok: false, errorCode: error.code, error: error.message };
  if (error instanceof McpError)
    return {
      op,
      ok: false,
      errorCode:
        error.code === "timeout"
          ? "timeout"
          : error.code === "aborted"
            ? "aborted"
            : "backend_error",
      error: error.message,
    };
  return {
    op,
    ok: false,
    errorCode: "backend_error",
    error: error instanceof Error ? error.message : String(error),
  };
}

export interface CuaDriverProviderOptions {
  /** The MCP server to run; by default the installed `cua-driver mcp`. */
  command?: () => { command: string; args: string[] } | undefined;
  env?: NodeJS.ProcessEnv;
  encodeImage?: ImageEncoder;
  startTimeoutMs?: number;
  /** The longest a single tool call may take (the request deadline rules). */
  callTimeoutMs?: number;
  maxImageBytes?: number;
}

export function createCuaDriverProvider(
  options: CuaDriverProviderOptions = {},
): ResourceProvider {
  const env = cuaDriverEnv(options.env ?? process.env);
  const command =
    options.command ??
    (() => {
      const binary = resolveCuaDriverBinary(env);
      return binary ? { command: binary, args: ["mcp"] } : undefined;
    });
  const encode = options.encodeImage ?? sipsJpegEncoder();
  return {
    id: cuaDriverBackend,
    type: "computer_use",
    platforms: ["darwin"],
    async open() {
      const resolved = command();
      if (!resolved)
        throw new ProviderError(
          "backend_not_installed",
          "cua-driver is not installed on this Mac",
        );
      const client = new McpStdioClient({ ...resolved, env });
      try {
        await client.start(options.startTimeoutMs ?? 20_000);
      } catch (error) {
        await client.close();
        throw new ProviderError(
          "backend_unavailable",
          `could not start cua-driver mcp: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return cuaDriverSession(client, encode, options);
    },
  };
}

function cuaDriverSession(
  client: McpStdioClient,
  encode: ImageEncoder,
  options: CuaDriverProviderOptions,
): ProviderSession {
  return {
    get alive() {
      return client.alive;
    },
    async invoke(action, signal) {
      try {
        const mapped = mapComputerUseAction(action);
        if (mapped.kind === "wait") {
          await sleep(mapped.ms, signal);
          return { op: action.op, ok: true, text: `waited ${mapped.ms} ms` };
        }
        if (!client.tools.has(mapped.tool))
          return {
            op: action.op,
            ok: false,
            errorCode: "backend_unsupported",
            error: `this cua-driver has no ${mapped.tool} tool (${action.op}); update cua-driver`,
          };
        const result = await client.callTool(
          mapped.tool,
          mapped.args,
          options.callTimeoutMs ?? 120_000,
          signal,
        );
        return await convertToolResult(
          action.op,
          result,
          encode,
          options.maxImageBytes,
        );
      } catch (error) {
        return failure(action.op, error, signal);
      }
    },
    async reset() {
      // Background input holds no keys between calls; ending the session
      // runs cua-driver's own cleanup (cursor overlay, recording).
      if (!client.alive || !client.tools.has("end_session")) return;
      try {
        await client.callTool("end_session", {}, 5000);
      } catch {
        // Best effort: closing the process ends the session too.
      }
    },
    close: () => client.close(),
  };
}
