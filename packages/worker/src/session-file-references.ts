// Paths an answer names, verified on this device. A leaf module: the session
// file ledger resolves a finished answer with it, and reads share its list
// of private locations.
//
// Only a path that exists, and that the session may show, becomes a
// reference: like a terminal's file links, nothing is linked on a guess.
// A file the answer names before it is written (a background subagent's
// deliverable) is a pending reference: it links once the file exists.

import { realpathSync, statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { within } from "./paths.js";

/** What one turn's answer is checked against. */
export interface FileReferenceContext {
  answer: string;
  /** The session's working directory: its workspace. */
  workspacePath: string;
  /** Files the session's tools wrote or earlier answers named. */
  recorded: Array<{
    path: string;
    realpath?: string;
    origin: string;
    pending?: boolean;
  }>;
  /** Epoch ms the turn started; named files outside the workspace are newer. */
  turnStartedAt: number;
  /** Where named files outside the workspace may live. */
  allowedRoots?: string[];
  home?: string;
}

/** A named path the device verified. */
export interface ResolvedFileReference {
  /** As it appears in the answer: code span content, link target or path. */
  text: string;
  /** Linked in the answer's text (code spans and links, not bare paths). */
  linkable: boolean;
  path: string;
  realpath: string;
  kind: "file" | "dir";
  insideWorkspace: boolean;
  bytes?: number;
  mtimeMs?: number;
  /**
   * No file there yet: a linked name whose folder exists and may be shown.
   * `realpath` is where it will resolve: its folder's, plus its name.
   */
  pending?: true;
}

export interface ReferenceToken {
  text: string;
  path: string;
  source: "code" | "link" | "bare";
}

export interface ReferenceBlock {
  list: boolean;
  tokens: ReferenceToken[];
}

/** Candidates checked per answer, at most. */
export const maxReferenceCandidates = 200;

/** File timestamps can lag the clock by a filesystem's resolution. */
const mtimeToleranceMs = 2000;

/**
 * Whether a path is in the workspace's attachments, where the person's
 * uploads land and where agents save what they want to show the person.
 */
export function workspaceAttachmentPath(
  path: string,
  workspacePath: string,
): boolean {
  return within(resolve(workspacePath, ".foundry", "attachments"), path);
}

/**
 * Whether a path is somewhere a session must never show: credentials, agent
 * and Foundry state (the device's and the workspace's own `.foundry`, except
 * its attachments), and Git internals. Checked on the path as named and on
 * the file it resolves to.
 */
export function privateDevicePath(
  path: string,
  home: string = homedir(),
  workspacePath?: string,
): boolean {
  if (
    workspacePath &&
    within(resolve(workspacePath, ".foundry"), path) &&
    !workspaceAttachmentPath(path, workspacePath)
  )
    return true;
  const homeRelative = relative(home, path);
  if (
    homeRelative &&
    !homeRelative.startsWith("..") &&
    !isAbsolute(homeRelative)
  ) {
    const first = homeRelative.split(sep)[0]!;
    if (
      first === ".ssh" ||
      first === ".foundry" ||
      first === ".codex" ||
      first.startsWith(".claude")
    )
      return true;
  }
  if (path.split(sep).includes(".git")) return true;
  const name = basename(path);
  return (
    name.endsWith(".pem") || name.startsWith("id_") || name.startsWith(".env")
  );
}

/** Where named files outside the workspace may live: temporary folders. */
export function defaultReferenceRoots(workspacePath: string): string[] {
  return [tmpdir(), "/tmp", process.env.TMPDIR ?? "", workspacePath].filter(
    Boolean,
  );
}

/**
 * The path a candidate names: line and column suffixes (`:12`, `:12:4`,
 * `#L10-L20`), a `file://` scheme, quotes and trailing punctuation removed.
 * Undefined for text that is not shaped like a path.
 */
export function candidatePath(text: string): string | undefined {
  let value = text.trim().replace(/^["']|["']$/g, "");
  if (/^file:\/\//i.test(value)) value = value.slice("file://".length);
  value = value
    .replace(/#L\d+(?:-L?\d+)?$/, "")
    .replace(/[.,;!?)\]]+$/, "")
    .replace(/:\d+(?:[:-]\d+)?$/, "")
    .replace(/:$/, "");
  if (
    !value ||
    /[\s*?<>|$`"{}]/.test(value) ||
    value.startsWith("-") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    return undefined;
  const pathShaped =
    value.includes("/") || /^[^/]+\.[A-Za-z0-9]{1,12}$/.test(value);
  return pathShaped ? value : undefined;
}

const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
const codeSpan = /(`+)([^`]+?)\1/g;
const markdownLink = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const barePath = /(?:^|[\s(<[“"'])((?:~\/|\/)[^\s`'"<>()[\]{}]+)/g;

/** Paths named in each block of the answer, outside fenced code. */
export function answerBlocks(answer: string): ReferenceBlock[] {
  const blocks: ReferenceBlock[] = [];
  let current: ReferenceBlock | undefined;
  let fence: string | undefined;
  let candidates = 0;
  for (const line of answer.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0];
      else if (fenceMatch[1]![0] === fence) fence = undefined;
      current = undefined;
      continue;
    }
    if (fence) continue;
    if (!line.trim()) {
      current = undefined;
      continue;
    }
    const isListItem = listItem.test(line);
    // A list right after a paragraph is its own block, even without a gap.
    if (!current || (isListItem && !current.list)) {
      current = { list: isListItem, tokens: [] };
      blocks.push(current);
    }
    for (const token of lineTokens(line)) {
      if (candidates >= maxReferenceCandidates) return blocks;
      current.tokens.push(token);
      candidates += 1;
    }
  }
  return blocks;
}

function lineTokens(line: string): ReferenceToken[] {
  const tokens: Array<ReferenceToken & { index: number }> = [];
  let rest = line;
  for (const match of line.matchAll(codeSpan)) {
    const text = match[2]!.trim();
    const path = candidatePath(text);
    if (path) tokens.push({ text, path, source: "code", index: match.index });
    rest = rest.replace(match[0], " ".repeat(match[0].length));
  }
  for (const match of rest.matchAll(markdownLink)) {
    const text = match[1]!;
    const path = candidatePath(text);
    if (path) tokens.push({ text, path, source: "link", index: match.index });
    rest = rest.replace(match[0], " ".repeat(match[0].length));
  }
  for (const match of rest.matchAll(barePath)) {
    const text = match[1]!.replace(/[.,;:!?)\]]+$/, "");
    const path = candidatePath(text);
    // Bare text is a path only when it names a file with an extension.
    if (path && /\.[A-Za-z0-9]{1,12}$/.test(path))
      tokens.push({ text, path, source: "bare", index: match.index });
  }
  return tokens
    .sort((left, right) => left.index - right.index)
    .map(({ index: _index, ...token }) => token);
}

function expandHome(path: string, home: string): string | undefined {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return undefined;
}

function statPath(path: string): { stat: Stats; realpath: string } | undefined {
  try {
    return { stat: statSync(path), realpath: realpathSync(path) };
  } catch {
    return undefined;
  }
}

function realRoot(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The paths a finished answer names that exist on this device and may be
 * shown. A relative name resolves by the first of these sources that has an
 * existing match: the session's recorded files and their folders (by
 * suffix), the folders the answer names before it (or in its paragraph),
 * then the workspace. Two matches from that source are ambiguous and link
 * nothing (DEV-081). Files and folders resolve alike; outside the
 * workspace a folder counts only when it holds recorded files, and a file
 * no tool wrote must be in a temporary folder and changed during the turn.
 *
 * A linked name of a file that is not there yet is pending when it reads as
 * a location (a folder and a file name with an extension), its folder
 * exists in the workspace or a temporary folder and may be shown, and the
 * session never recorded a file there (a file it wrote is gone, not due).
 */
export function resolveFileReferences(
  context: FileReferenceContext,
): ResolvedFileReference[] {
  const home = context.home ?? homedir();
  const workspace = realRoot(context.workspacePath) ?? context.workspacePath;
  const roots = (
    context.allowedRoots ?? defaultReferenceRoots(context.workspacePath)
  )
    .map(realRoot)
    .filter((root): root is string => Boolean(root));
  const broadFolders = [...roots, workspace, realRoot(home) ?? home];
  const recordedTool = new Set<string>();
  const recordedAll: string[] = [];
  for (const entry of context.recorded) {
    // A pending name is not a file yet: it neither fills a folder nor is due.
    if (entry.pending) continue;
    for (const path of [entry.path, entry.realpath].filter(Boolean)) {
      recordedAll.push(path!);
      if (entry.origin === "tool") recordedTool.add(path!);
    }
  }

  const absolute = (path: string): string | undefined =>
    expandHome(path, home) ?? (isAbsolute(path) ? resolve(path) : undefined);

  /**
   * Where a relative name may lead, from the first source with any existing
   * match: recorded paths ending in it (or folders of them), then the named
   * `folders`, then the workspace. Distinct by the file they resolve to.
   */
  const matchesOf = (name: string, folders: string[]): string[] => {
    const relativeName = name.replace(/^\.\//, "").replace(/[\\/]+$/, "");
    const suffix = `${sep}${relativeName.split("/").join(sep)}`;
    const recorded = new Set<string>();
    for (const entry of context.recorded) {
      if (entry.path.endsWith(suffix)) recorded.add(entry.path);
      const inner = entry.path.lastIndexOf(`${suffix}${sep}`);
      if (inner >= 0) recorded.add(entry.path.slice(0, inner + suffix.length));
    }
    for (const source of [
      [...recorded],
      folders.map((folder) => resolve(folder, relativeName)),
      [resolve(context.workspacePath, relativeName)],
    ]) {
      const found = new Map<string, string>();
      for (const path of source) {
        const real = statPath(path)?.realpath;
        if (real && !found.has(real)) found.set(real, path);
      }
      if (found.size) return [...found.values()];
    }
    return [];
  };

  /** The one path a name leads to; `ambiguous` when it leads to several. */
  const locate = (
    token: ReferenceToken,
    folders: string[],
  ): { path?: string; ambiguous?: true } => {
    const direct = absolute(token.path);
    if (direct) return { path: direct };
    const matches = matchesOf(token.path, folders);
    if (matches.length > 1) return { ambiguous: true };
    return { path: matches[0] };
  };

  const verify = (
    text: string,
    linkable: boolean,
    path: string,
  ): ResolvedFileReference | undefined => {
    const found = statPath(path);
    if (!found) return undefined;
    if (
      privateDevicePath(path, home, context.workspacePath) ||
      privateDevicePath(found.realpath, home, workspace)
    )
      return undefined;
    const insideWorkspace = within(workspace, found.realpath);
    if (found.stat.isDirectory()) {
      // A temporary root, the workspace, home or a folder above them holds
      // everything; naming it points at no work of the session.
      if (
        broadFolders.some(
          (folder) => within(path, folder) || within(found.realpath, folder),
        )
      )
        return undefined;
      // In the workspace a folder that exists links, as a file does.
      const holdsRecorded =
        insideWorkspace ||
        recordedAll.some(
          (recorded) =>
            recorded !== path &&
            recorded !== found.realpath &&
            (within(path, recorded) || within(found.realpath, recorded)),
        );
      return holdsRecorded
        ? {
            text,
            linkable,
            path,
            realpath: found.realpath,
            kind: "dir",
            insideWorkspace,
          }
        : undefined;
    }
    if (!found.stat.isFile()) return undefined;
    const writtenByTool =
      recordedTool.has(path) || recordedTool.has(found.realpath);
    if (
      !insideWorkspace &&
      !writtenByTool &&
      (found.stat.mtimeMs < context.turnStartedAt - mtimeToleranceMs ||
        !roots.some((root) => within(root, found.realpath)))
    )
      return undefined;
    return {
      text,
      linkable,
      path,
      realpath: found.realpath,
      kind: "file",
      insideWorkspace,
      bytes: found.stat.size,
      mtimeMs: found.stat.mtimeMs,
    };
  };

  const pending = (
    token: ReferenceToken,
    located: string | undefined,
    base?: string,
  ): ResolvedFileReference | undefined => {
    if (
      token.source === "bare" ||
      !token.path.includes("/") ||
      !/\.[A-Za-z0-9]{1,12}$/.test(basename(token.path))
    )
      return undefined;
    const candidates = located
      ? [located]
      : [base, context.workspacePath]
          .filter((folder): folder is string => Boolean(folder))
          .map((folder) => resolve(folder, token.path));
    for (const path of candidates) {
      if (statPath(path)) return undefined;
      const folder = statPath(dirname(path));
      if (!folder?.stat.isDirectory()) continue;
      const realpath = join(folder.realpath, basename(path));
      if (
        privateDevicePath(path, home, context.workspacePath) ||
        privateDevicePath(realpath, home, workspace) ||
        recordedAll.includes(path) ||
        recordedAll.includes(realpath)
      )
        return undefined;
      const insideWorkspace = within(workspace, realpath);
      if (!insideWorkspace && !roots.some((root) => within(root, realpath)))
        return undefined;
      return {
        text: token.text,
        linkable: true,
        path,
        realpath,
        kind: "file",
        insideWorkspace,
        pending: true,
      };
    }
    return undefined;
  };

  const files: ResolvedFileReference[] = [];
  const folders: Array<{ text: string; linkable: boolean; path: string }> = [];
  // Folders the answer has named so far, in order: bases for later names.
  const named: string[] = [];
  for (const block of answerBlocks(context.answer)) {
    const found: Array<ResolvedFileReference | undefined> = [];
    const unresolved: number[] = [];
    const resolveFile = (index: number, retry: boolean) => {
      const token = block.tokens[index]!;
      const located = locate(token, named);
      if (!located.path && !located.ambiguous && !retry) {
        unresolved.push(index);
        return;
      }
      const verified = located.path
        ? verify(token.text, token.source !== "bare", located.path)
        : undefined;
      found[index] =
        verified ??
        (located.ambiguous
          ? undefined
          : pending(token, located.path, named.at(-1)));
    };
    block.tokens.forEach((token, index) => {
      if (token.source !== "bare") {
        const located = locate(token, named);
        if (located.path && statPath(located.path)?.stat.isDirectory()) {
          named.push(located.path);
          folders.push({
            text: token.text,
            linkable: true,
            path: located.path,
          });
          return;
        }
      }
      resolveFile(index, false);
    });
    // A folder named later in the paragraph is a base too: "`a.md` in `docs/`".
    for (const index of unresolved) resolveFile(index, true);
    for (const reference of found) if (reference) files.push(reference);
  }

  // Folders link only once their recorded files are known, these included.
  for (const file of files)
    if (!file.pending) recordedAll.push(file.path, file.realpath);
  const references = [...files];
  for (const folder of folders) {
    const verified = verify(folder.text, folder.linkable, folder.path);
    if (verified) references.push(verified);
  }
  return references;
}
