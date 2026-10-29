// Path shapes in an answer. Paths inside the workspace link only when the
// device verified them at the end of the turn (DEV-081); a file of the
// device outside the workspace links for its owner by shape, and the device
// decides what is shown when it is opened.

import type { ConversationFileReference } from "./conversation-types";

/** File names without an extension that are files, not folders. */
const extensionlessFiles = new Set([
  "makefile",
  "dockerfile",
  "containerfile",
  "justfile",
  "procfile",
  "gemfile",
  "rakefile",
  "brewfile",
  "vagrantfile",
  "caddyfile",
  "license",
  "readme",
  "changelog",
  "codeowners",
]);

const extension = /\.([a-z0-9]{1,10})$/;

/** A Windows drive path, `C:\` or `C:/`. */
const drivePath = /^[A-Za-z]:[\\/]/;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || drivePath.test(path);
}

/** Forward slashes, no trailing slash: how paths are compared here. */
function normalized(path: string): string {
  const value = path.replace(/\\/g, "/");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * The path a text names: line and column suffixes (`:12`, `:12:4`,
 * `#L10-L20`), a `file://` scheme, quotes and trailing punctuation removed.
 * Undefined for text that is not shaped like a path, as on the device.
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
    (/^[a-z][a-z0-9+.-]*:/i.test(value) && !drivePath.test(value))
  )
    return undefined;
  return value;
}

/** A path inside `root` relative to it, as the workspace file API takes. */
export function workspaceRelativePath(path: string, root: string): string {
  const base = normalized(root);
  const value = normalized(path);
  return value.length > base.length && value[base.length] === "/"
    ? value.slice(base.length + 1)
    : value;
}

/** Whether `path` is the workspace folder `root` or inside it. */
function insideRoot(path: string, root: string): boolean {
  const base = normalized(root);
  const value = normalized(path);
  const [a, b] = drivePath.test(base)
    ? [value.toLowerCase(), base.toLowerCase()]
    : [value, base];
  return a === b || a.startsWith(`${b}/`);
}

/**
 * A link for a file of the device outside the workspace `root`: an absolute
 * path or one in the home folder (`~/…`) that reads as a file (a name with
 * an extension, or a known file name). Folders are not linked, nor is a path
 * inside the workspace: those link only once the device verified them.
 * Only for the device's owner; the device decides what may be shown when it
 * is opened.
 */
export function devicePathReference(
  text: string,
  root?: string,
): ConversationFileReference | undefined {
  const path = candidatePath(text);
  if (!path || path.endsWith("/") || path.endsWith("\\")) return undefined;
  const home = path.startsWith("~/");
  if (!home && !isAbsolutePath(path)) return undefined;
  if (root && !home && insideRoot(path, root)) return undefined;
  const segments = normalized(path).split("/");
  if (segments.some((segment) => segment === ".." || segment === "."))
    return undefined;
  const name = segments.at(-1) ?? "";
  // A dot file names a file too: `~/.zshrc`, `/srv/app/.env`.
  const file =
    extension.test(name.toLowerCase()) ||
    extensionlessFiles.has(name.toLowerCase()) ||
    /^\.[\w.-]+$/.test(name);
  if (!file || (home && segments.length < 2)) return undefined;
  return {
    text: text.trim(),
    path,
    kind: "file",
    unverified: true,
    device: true,
  };
}
