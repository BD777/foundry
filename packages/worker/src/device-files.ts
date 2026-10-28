// Files of this device outside its workspaces, read for the device's owner
// from a path an answer named. The server asks only for the owner, with the
// owner's switch on; this side decides what may be shown at all: never a
// credential store, a browser profile or anything but a regular file, and a
// file that looks like a secret only when the owner reveals it.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type {
  DeviceFileRead,
  ReadDeviceFilePayload,
} from "@bd777/foundry-protocol";
import { FileDownloadError, readFileDownloadChunk } from "./file-downloads.js";
import { looksBinary, readFilePrefix, utf8Prefix } from "./session-files.js";

/** How much of a file is shown; a download brings the rest. */
export const deviceFilePreviewBytes = 128 * 1024;

/**
 * Places Foundry never opens, relative to the home folder: login and key
 * stores of the system, cloud and developer tools, Foundry and the agents'
 * own credentials, password managers and browser profiles.
 */
const deniedHomePaths = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".foundry",
  ".codex",
  ".claude",
  ".claude.json",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".password-store",
  ".config/gcloud",
  ".config/gh/hosts.yml",
  ".local/share/keyrings",
  ".pki",
  // Browser profiles (cookies, saved passwords).
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".config/vivaldi",
  ".config/opera",
  "snap/firefox",
  "snap/chromium",
  // macOS.
  "Library/Keychains",
  "Library/Cookies",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/com.apple.TCC",
  // Windows.
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Local/Microsoft/Vault",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
  "AppData/Local/BraveSoftware",
  "AppData/Roaming/Mozilla",
];

/** Absolute places Foundry never opens. */
const deniedRoots = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/ssh",
  "/proc",
  "/sys",
  "/dev",
  "/Library/Keychains",
  "/System/Library/Keychains",
  "/private/var/db",
];

const caseless = process.platform === "darwin" || process.platform === "win32";

function comparable(path: string): string {
  const value = path.split(sep).join("/");
  return caseless ? value.toLowerCase() : value;
}

function under(root: string, path: string): boolean {
  const base = comparable(root).replace(/\/+$/, "");
  const target = comparable(path);
  return target === base || target.startsWith(`${base}/`);
}

/** Whether a path is somewhere Foundry never opens. */
export function deniedDevicePath(path: string, home: string): boolean {
  if (deniedRoots.some((root) => under(root, path))) return true;
  if (deniedHomePaths.some((entry) => under(resolve(home, entry), path)))
    return true;
  // Git internals hold remote credentials; keychain files may live anywhere.
  const parts = comparable(path).split("/");
  return (
    parts.includes(".git") || /\.(keychain|keychain-db)$/i.test(basename(path))
  );
}

const sensitiveExtensions = /\.(key|pem|p12|pfx|jks|keystore|kdbx|ppk|gpg)$/i;
const sensitiveWords = /(token|secret|credential|passw(or)?d|api[-_]?key)/i;

/**
 * Whether a file looks like a secret, by its name or the start of its
 * contents: shown masked until the owner reveals it, never downloaded.
 */
export function sensitiveDeviceFile(path: string, start?: Buffer): boolean {
  const name = basename(path);
  if (
    sensitiveExtensions.test(name) ||
    name.startsWith(".env") ||
    name.startsWith("id_") ||
    sensitiveWords.test(name)
  )
    return true;
  return start
    ? /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(
        start.subarray(0, 4096).toString("latin1"),
      )
    : false;
}

/** The absolute path a request names, `~` meaning the home folder. */
export function deviceFilePath(path: string, home: string): string | undefined {
  const value = path.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : undefined;
}

/** Checks a path and answers what it is, without its contents. */
function inspect(
  path: string,
  home: string,
): { answer: DeviceFileRead; realPath?: string } {
  const named = deviceFilePath(path, home);
  if (!named) return { answer: { path, kind: "missing" } };
  if (deniedDevicePath(named, home))
    return { answer: { path, kind: "denied" } };
  let realPath: string;
  try {
    realPath = realpathSync(named);
  } catch {
    return { answer: { path, kind: "missing" } };
  }
  // A link must not lead somewhere the path as named could not go.
  if (deniedDevicePath(realPath, home))
    return { answer: { path, kind: "denied" } };
  let stat;
  try {
    stat = statSync(realPath);
  } catch {
    return { answer: { path, kind: "missing" } };
  }
  if (!stat.isFile()) return { answer: { path, kind: "not_file" } };
  return {
    answer: {
      path,
      kind: "file",
      realPath,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    },
    realPath,
  };
}

/** Answers read_device_file: what the file is, its start or a chunk. */
export function readDeviceFile(
  payload: ReadDeviceFilePayload,
  home: string = homedir(),
): DeviceFileRead {
  const { answer, realPath } = inspect(payload.path, home);
  if (!realPath) return answer;
  if (payload.download) {
    const sensitive = sensitiveDeviceFile(
      realPath,
      readFilePrefix(realPath, 4096).data,
    );
    if (sensitive)
      return {
        path: payload.path,
        kind: "file",
        sensitive,
        code: "sensitive",
        error: "a file that looks like a secret is not downloaded",
      };
    try {
      return {
        path: payload.path,
        kind: "file",
        downloadChunk: readFileDownloadChunk(realPath, payload.download),
      };
    } catch (error) {
      if (error instanceof FileDownloadError)
        return {
          path: payload.path,
          kind: "file",
          code: error.code,
          error: error.message,
        };
      throw error;
    }
  }
  const read = readFilePrefix(realPath, deviceFilePreviewBytes);
  const sensitive = sensitiveDeviceFile(realPath, read.data);
  const binary = looksBinary(read.data);
  const shown =
    !binary &&
    (payload.mode === "reveal" || (payload.mode === "read" && !sensitive));
  return {
    ...answer,
    sensitive,
    binary,
    ...(shown
      ? {
          content: utf8Prefix(read.data),
          truncated: read.size > deviceFilePreviewBytes,
        }
      : {}),
  };
}
