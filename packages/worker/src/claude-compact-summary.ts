/**
 * The summary Claude Code continues from after it compacts a session's
 * context (DEV-083). The SDK reports the compaction (compact_boundary, with
 * its token counts) but not the summary: Claude Code writes that to the
 * session's own transcript, as the user message marked isCompactSummary
 * right after the boundary. Read there, only to show it; nothing is sent
 * back to the agent.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { contentText, record, string } from "./json-values.js";
import { nativeExecutionHome } from "./native-runtime-paths.js";
import { foundryStatePath } from "./state-root.js";

/** How much of a transcript's end is read for the summary. */
const tailBytes = 4 * 1024 * 1024;
/** The longest summary kept; longer ones are cut. */
export const compactSummaryLimit = 64_000;

/** The Claude homes a Foundry session's transcript can be in. */
function claudeHomes(): string[] {
  const homes = [nativeExecutionHome("claude", process.env)];
  const owners = foundryStatePath("native-runtime", "owners", "claude");
  try {
    for (const owner of readdirSync(owners)) homes.push(resolve(owners, owner));
  } catch {
    // No managed homes on this device.
  }
  return homes;
}

/** The transcript of a Claude session, by its native id. */
export function claudeTranscriptFile(
  nativeSessionId: string,
  homes = claudeHomes(),
): string | undefined {
  if (!/^[\w-]{8,}$/.test(nativeSessionId)) return undefined;
  for (const home of homes) {
    const projects = resolve(home, "projects");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projects);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const candidate = resolve(projects, dir, `${nativeSessionId}.jsonl`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The summary written after the compaction named boundaryUuid (or the last
 * one), if the transcript has it yet.
 */
export function claudeCompactSummary(
  path: string,
  boundaryUuid?: string,
): string | undefined {
  let lines: string[];
  try {
    lines = tail(path).split("\n");
  } catch {
    return undefined;
  }
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (
      line.includes('"compact_boundary"') &&
      (!boundaryUuid || line.includes(boundaryUuid))
    ) {
      start = index;
      break;
    }
  }
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.includes('"isCompactSummary"')) continue;
    try {
      const entry = record(JSON.parse(line));
      if (entry.isCompactSummary !== true) continue;
      return compactSummaryText(entry);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** A summary message's text, cut to the limit. */
export function compactSummaryText(
  entry: Record<string, unknown>,
): string | undefined {
  const text = contentText(record(entry.message).content).trim();
  if (!text) return undefined;
  return text.length > compactSummaryLimit
    ? `${text.slice(0, compactSummaryLimit)}…`
    : text;
}

/** The boundary's own id in the transcript, as the SDK reports it. */
export function compactBoundaryUuid(message: unknown): string | undefined {
  const value = record(message);
  return value.type === "system" && value.subtype === "compact_boundary"
    ? string(value.uuid) || undefined
    : undefined;
}
