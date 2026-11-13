// A read-only workspace session's sandbox refuses every write to its
// workspace. When one of its tool calls fails that way the person sees it
// as its own event, naming the path (or the command). Conservative: only a
// read-only session's calls, only errors that say the file system refused,
// only paths inside its workspace.

import { isAbsolute, resolve } from "node:path";
import { within } from "../platform/paths.js";

export const workspaceWriteRefusedLabel = "Workspace write refused";

const maxDetail = 300;

/** The file system refused because it is mounted read-only (Linux). */
const readOnlyError = /\bEROFS\b|read-only file system/i;
/** The sandbox refused (macOS). */
const sandboxDenied = /\bEPERM\b|operation not permitted/i;
/** The sandbox or the file's permissions refused. */
const deniedError =
  /\bEPERM\b|\bEACCES\b|operation not permitted|permission denied/i;
/** A denial a shell reports for a write, not a read. */
const shellWriteWords =
  /cannot (?:create|touch|remove|make|move|overwrite|open .* for writing)|unable to (?:create|write|unlink)|could not (?:lock|write|create)|for writing/i;

const fileTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const shellTools = new Set(["Bash"]);

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxDetail ? `${flat.slice(0, maxDetail - 1)}…` : flat;
}

function insideWorkspace(
  workspacePath: string,
  path: string,
): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const absolute = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(workspacePath, trimmed);
  return within(workspacePath, absolute) ? absolute : undefined;
}

/** The paths an error line names: quoted ones, then the one before the error. */
function pathsInLine(line: string): string[] {
  const paths: string[] = [];
  for (const match of line.matchAll(/'([^']+)'|"([^"]+)"|‘([^’]+)’|`([^`]+)`/g))
    paths.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
  const error = line.search(
    /:\s*(?:read-only file system|permission denied|operation not permitted)/i,
  );
  if (error > 0) {
    const segment = line.slice(0, error).split(": ").pop() ?? "";
    const word = segment.trim().split(/\s+/).pop();
    const bare = word?.replace(/^['"‘`]+|['"’`,;]+$/g, "");
    if (bare) paths.push(bare);
  }
  return paths.filter(Boolean);
}

/**
 * The workspace path a shell's output says a write to was refused, or the
 * command when the output names the workspace but no single path.
 */
export function shellWriteRefusal(
  command: string,
  output: string,
  workspacePath: string,
): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (
      !readOnlyError.test(line) &&
      !sandboxDenied.test(line) &&
      !(deniedError.test(line) && shellWriteWords.test(line))
    )
      continue;
    for (const candidate of pathsInLine(line)) {
      const path = insideWorkspace(workspacePath, candidate);
      if (path) return short(path);
    }
    if (line.includes(workspacePath)) return short(command || line);
  }
  return undefined;
}

/** The workspace path a failed file edit was refused for. */
export function fileWriteRefusal(
  paths: readonly string[],
  output: string | undefined,
  workspacePath: string,
): string | undefined {
  // Without error text (a failed Codex file change) the failure itself is
  // the evidence: nothing else stops an edit inside a read-only workspace.
  if (
    output !== undefined &&
    !readOnlyError.test(output) &&
    !deniedError.test(output)
  )
    return undefined;
  for (const candidate of paths) {
    const path = insideWorkspace(workspacePath, candidate);
    if (path) return short(path);
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text ?? "")
            : "",
      )
      .join("\n");
  return "";
}

function stringField(value: unknown, key: string): string {
  const field =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "string" ? field : "";
}

/** A finished Claude tool call's refused workspace write, if it was one. */
export function claudeWriteRefusal(
  tool: { name: string; input?: unknown; content?: unknown; failed: boolean },
  workspacePath: string,
): string | undefined {
  const output = text(tool.content);
  if (shellTools.has(tool.name))
    return shellWriteRefusal(
      stringField(tool.input, "command"),
      output,
      workspacePath,
    );
  if (fileTools.has(tool.name) && tool.failed)
    return fileWriteRefusal(
      [
        stringField(tool.input, "file_path"),
        stringField(tool.input, "notebook_path"),
      ].filter(Boolean),
      output,
      workspacePath,
    );
  return undefined;
}

/** A finished Codex item's refused workspace write, if it was one. */
export function codexWriteRefusal(
  event: unknown,
  workspacePath: string,
): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  if (record.type !== "item.completed" || !item) return undefined;
  if (item.type === "command_execution")
    return shellWriteRefusal(
      stringField(item, "command"),
      stringField(item, "aggregated_output"),
      workspacePath,
    );
  if (item.type === "file_change" && item.status === "failed")
    return fileWriteRefusal(
      Array.isArray(item.changes)
        ? item.changes.map((change) => stringField(change, "path"))
        : [],
      undefined,
      workspacePath,
    );
  return undefined;
}
