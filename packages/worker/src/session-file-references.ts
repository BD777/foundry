// Paths an answer names, verified on this device. A leaf module: the session
// file ledger resolves a finished answer with it, and reads share its list
// of private locations.
//
// Only a path that exists, and that the session may show, becomes a
// reference: like a terminal's file links, nothing is linked on a guess.

import { realpathSync, statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** What one turn's answer is checked against. */
export interface FileReferenceContext {
  answer: string;
  /** The session's working directory: its workspace. */
  workspacePath: string;
  /** Files the session's tools wrote or earlier answers named. */
  recorded: Array<{ path: string; realpath?: string; origin: string }>;
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
 * Whether a path is somewhere a session must never show: credentials, agent
 * and Foundry state (the device's and the workspace's own `.foundry`), and
 * Git internals. Checked on the path as named and on the file it resolves to.
 */
export function privateDevicePath(
  path: string,
  home: string = homedir(),
  workspacePath?: string,
): boolean {
  if (workspacePath && pathWithin(resolve(workspacePath, ".foundry"), path))
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

/** Whether `path` is `root` or inside it. */
export function pathWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
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
 * shown. Relative names resolve against the folder named nearest them (in
 * their paragraph, or the paragraph a list follows), then the workspace,
 * then a unique match among the session's recorded files. A folder counts
 * only when it holds recorded files; a file outside the workspace that no
 * tool wrote must be in a temporary folder and changed during the turn.
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
  const recordedTool = new Set<string>();
  const recordedAll: string[] = [];
  for (const entry of context.recorded) {
    for (const path of [entry.path, entry.realpath].filter(Boolean)) {
      recordedAll.push(path!);
      if (entry.origin === "tool") recordedTool.add(path!);
    }
  }

  const absolute = (path: string): string | undefined =>
    expandHome(path, home) ?? (isAbsolute(path) ? resolve(path) : undefined);

  const directoryOf = (
    token: ReferenceToken,
    base?: string,
  ): string | undefined => {
    const path =
      absolute(token.path) ??
      (base ? resolve(base, token.path) : resolve(workspace, token.path));
    const found = statPath(path);
    return found?.stat.isDirectory() ? path : undefined;
  };

  const locate = (token: ReferenceToken, base?: string): string | undefined => {
    const direct = absolute(token.path);
    if (direct) return direct;
    for (const folder of [base, context.workspacePath]) {
      if (!folder) continue;
      const path = resolve(folder, token.path);
      if (statPath(path)) return path;
    }
    const suffix = `${sep}${token.path.replace(/^\.\//, "")}`;
    const matches = [
      ...new Set(
        context.recorded
          .map((entry) => entry.path)
          .filter((path) => path.endsWith(suffix)),
      ),
    ];
    return matches.length === 1 ? matches[0] : undefined;
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
    const insideWorkspace = pathWithin(workspace, found.realpath);
    if (found.stat.isDirectory()) {
      const holdsRecorded = recordedAll.some(
        (recorded) =>
          recorded !== path &&
          recorded !== found.realpath &&
          (pathWithin(path, recorded) || pathWithin(found.realpath, recorded)),
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
        !roots.some((root) => pathWithin(root, found.realpath)))
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

  const files: ResolvedFileReference[] = [];
  const folders: Array<{ text: string; linkable: boolean; path: string }> = [];
  let carried: string | undefined;
  for (const block of answerBlocks(context.answer)) {
    const folderAt = block.tokens.map((token) =>
      token.source === "bare"
        ? undefined
        : directoryOf(token, block.list ? carried : undefined),
    );
    const firstFolder = folderAt.find(Boolean);
    let nearest: string | undefined;
    block.tokens.forEach((token, index) => {
      const folder = folderAt[index];
      if (folder) {
        nearest = folder;
        folders.push({ text: token.text, linkable: true, path: folder });
        return;
      }
      const base = nearest ?? (block.list ? carried : undefined) ?? firstFolder;
      const path = locate(token, base);
      const verified = path
        ? verify(token.text, token.source !== "bare", path)
        : undefined;
      if (verified) files.push(verified);
    });
    // A paragraph's folder carries into the list after it.
    carried = block.list ? (nearest ?? carried) : nearest;
  }

  // Folders link only once their recorded files are known, these included.
  for (const file of files) recordedAll.push(file.path, file.realpath);
  const references = [...files];
  for (const folder of folders) {
    const verified = verify(folder.text, folder.linkable, folder.path);
    if (verified) references.push(verified);
  }
  return references;
}
