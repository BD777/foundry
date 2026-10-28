// Paths an answer names that the device has not verified: a code span or a
// link target shaped like a file or folder inside the chat's workspace. They
// link without a request; opening one reads it from the device, whose
// workspace rules decide what is shown.

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

/**
 * Extensions a name standing alone (no folder) must have to be a file:
 * `config.json` is one, `console.log`, `Node.js` and `v1.2` are not.
 */
const standaloneExtensions = new Set([
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "ipynb",
  "java",
  "json",
  "jsonl",
  "jsx",
  "key",
  "kt",
  "lock",
  "md",
  "mdx",
  "mjs",
  "cjs",
  "pdf",
  "pem",
  "php",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "proto",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zip",
  "env",
]);

/** Library names written like files. */
const libraryNames =
  /^(?:node|next|nuxt|vue|three|d3|chart|express|ember|backbone|react)\.js$/i;

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

/** Whether a candidate reads as a folder: a trailing slash or no extension. */
function namesFolder(path: string): boolean {
  if (/[\\/]$/.test(path)) return true;
  const name = normalized(path).split("/").pop() ?? "";
  return !extension.test(name) && !extensionlessFiles.has(name.toLowerCase());
}

/**
 * Whether a relative candidate reads as a location rather than prose or a
 * name: `docs/plan.md`, `./bin/run`, `apps/web/`, `config.json`. Branches
 * (`feat/x`), packages (`@scope/pkg`), CIDRs (`10.0.0.0/8`), hosts
 * (`github.com/a/b`) and identifiers (`console.log`) are not.
 */
function relativeLocation(path: string): boolean {
  if (path.startsWith("@") || path.startsWith("~")) return false;
  const segments = path.replace(/\/+$/, "").split("/");
  if (segments.some((segment) => segment === "..")) return false;
  if (path.startsWith("./")) return path.length > 2;
  const name = segments.at(-1) ?? "";
  if (segments.length === 1 && path.endsWith("/"))
    return !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(name);
  if (segments.length === 1) {
    if (libraryNames.test(name)) return false;
    const ext = extension.exec(name)?.[1];
    return (
      (ext !== undefined && standaloneExtensions.has(ext)) ||
      extensionlessFiles.has(name.toLowerCase())
    );
  }
  // A host name first: a URL without its scheme.
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(segments[0]!))
    return false;
  if (segments.some((segment) => segment === "")) return false;
  if (path.endsWith("/")) return true;
  return extension.test(name) || extensionlessFiles.has(name.toLowerCase());
}

/**
 * A link for a path the answer names inside the workspace folder `root`, or
 * undefined. Paths outside the workspace and home-relative ones (`~/…`)
 * are not linked: the workspace's rules cannot serve them.
 */
export function workspacePathReference(
  text: string,
  root: string | undefined,
): ConversationFileReference | undefined {
  if (!root) return undefined;
  const path = candidatePath(text);
  if (!path) return undefined;
  const base = normalized(root);
  const caseless = drivePath.test(base);
  let absolute: string;
  if (isAbsolutePath(path)) {
    absolute = normalized(path);
    const inside = caseless
      ? absolute.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      : absolute.startsWith(`${base}/`);
    if (!inside) return undefined;
    const rest = absolute.slice(base.length + 1);
    if (rest.split("/").some((segment) => segment === ".." || segment === "."))
      return undefined;
  } else {
    if (!relativeLocation(path)) return undefined;
    absolute = `${base}/${normalized(path).replace(/^\.\//, "")}`;
  }
  return {
    text: text.trim(),
    path: absolute,
    kind: namesFolder(path) ? "dir" : "file",
    unverified: true,
  };
}

/** A path inside `root` relative to it, as the workspace file API takes. */
export function workspaceRelativePath(path: string, root: string): string {
  const base = normalized(root);
  const value = normalized(path);
  return value.length > base.length && value[base.length] === "/"
    ? value.slice(base.length + 1)
    : value;
}

/**
 * A link for a file of the device outside the workspace: an absolute path
 * or one in the home folder (`~/…`) that reads as a file (a name with an
 * extension, or a known file name). Folders are not linked. Only for the
 * device's owner; the device decides what may be shown when it is opened.
 */
export function devicePathReference(
  text: string,
): ConversationFileReference | undefined {
  const path = candidatePath(text);
  if (!path || path.endsWith("/") || path.endsWith("\\")) return undefined;
  const home = path.startsWith("~/");
  if (!home && !isAbsolutePath(path)) return undefined;
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
