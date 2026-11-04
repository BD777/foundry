import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  ConnectorExtensionManifest,
  ConnectorExtensionRepository,
  InstalledConnectorExtension,
} from "@bd777/foundry-protocol";
import {
  connectorModelProviders,
  saveConnectorModelProviders,
} from "../../harness/connector-model-providers.js";
import { foundryStatePath } from "../../platform/state-root.js";
import {
  tryReadJSONFile,
  writePrivateJSONAtomic,
} from "../../platform/storage.js";
import {
  ExtensionManifestError,
  manifestFileName,
  parseExtensionManifest,
} from "./manifest.js";

/**
 * Connector extensions installed on this device (docs/connector-extensions.md).
 * `foundry-worker extension add <folder>`, or the owner's click on the
 * Connectors page (a git folder, sources.ts), copies an extension into the
 * worker's state root, records a digest of its files and where they came
 * from, and lists it; the running worker reports it at once. Only the
 * device's owner installs one: never a workspace, a session or the server
 * on its own.
 */

const maxFiles = 4000;
const maxBytes = 256 * 1024 * 1024;

export type ExtensionErrorCode = "invalid_input" | "not_found" | "id_conflict";

const exitCodes: Record<ExtensionErrorCode, number> = {
  invalid_input: 2,
  id_conflict: 3,
  not_found: 4,
};

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly exitCode: number;
  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
    this.exitCode = exitCodes[code];
  }
}

export function extensionsRoot(): string {
  return foundryStatePath("extensions");
}

export function extensionsRegistryPath(): string {
  return join(extensionsRoot(), "registry.json");
}

/** Where an installed extension's files are. */
export function extensionDir(id: string): string {
  return join(extensionsRoot(), id, "current");
}

/** The extension's own private folder, kept across updates. */
export function extensionDataDir(id: string): string {
  return join(extensionsRoot(), id, "data");
}

interface RegistryFile {
  extensions?: InstalledConnectorExtension[];
}

function readRegistry(): InstalledConnectorExtension[] {
  const file = tryReadJSONFile<RegistryFile>(extensionsRegistryPath());
  return Array.isArray(file?.extensions) ? file.extensions : [];
}

function writeRegistry(extensions: InstalledConnectorExtension[]): void {
  writePrivateJSONAtomic(extensionsRegistryPath(), { extensions });
}

/** Every regular file under dir, relative and sorted; refuses links. */
function filesOf(dir: string): string[] {
  const files: string[] = [];
  let bytes = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink())
        throw new ExtensionError(
          "invalid_input",
          `${relative(dir, path)} is a symbolic link; an extension is plain files`,
        );
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.push(relative(dir, path));
        bytes += statSync(path).size;
        if (files.length > maxFiles || bytes > maxBytes)
          throw new ExtensionError(
            "invalid_input",
            `the extension is larger than ${maxFiles} files or ${maxBytes / 1024 / 1024} MiB`,
          );
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** SHA-256 over the files' names and contents. */
export function digestOf(dir: string): string {
  const hash = createHash("sha256");
  for (const file of filesOf(dir)) {
    hash.update(file).update("\0");
    hash.update(readFileSync(join(dir, file))).update("\0");
  }
  return hash.digest("hex");
}

export function readManifest(dir: string): ConnectorExtensionManifest {
  const path = join(dir, manifestFileName);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ExtensionError(
      "invalid_input",
      `${path} is missing or not JSON (${String(error)})`,
    );
  }
  try {
    return parseExtensionManifest(raw);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      throw new ExtensionError(
        "invalid_input",
        `${manifestFileName}: ${error.message}`,
      );
    throw error;
  }
}

export interface ExtensionChange {
  ok: true;
  action: "created" | "updated" | "unchanged" | "removed";
  extension?: InstalledConnectorExtension;
}

/**
 * Installs (or updates) the extension in sourceDir: a copy of its files,
 * swapped in at once, with their digest. builtinKinds are connector kinds
 * Foundry has itself; an extension may not reuse one, nor a kind another
 * extension provides.
 */
export function addExtension(
  sourceDir: string,
  builtinKinds: string[] = [],
  origin?: { source: ConnectorExtensionRepository; commit: string },
): ExtensionChange {
  const source = resolve(sourceDir);
  if (!existsSync(source) || !lstatSync(source).isDirectory())
    throw new ExtensionError("invalid_input", `${source} is not a folder`);
  const manifest = readManifest(source);
  const installed = readRegistry();
  for (const connector of manifest.connectors) {
    if (builtinKinds.includes(connector.kind))
      throw new ExtensionError(
        "id_conflict",
        `${connector.kind} is a connector Foundry has built in`,
      );
    const other = installed.find(
      (item) =>
        item.id !== manifest.id && item.connectors.includes(connector.kind),
    );
    if (other)
      throw new ExtensionError(
        "id_conflict",
        `${connector.kind} is provided by the extension ${other.id}`,
      );
  }
  const digest = digestOf(source);
  const previous = installed.find((item) => item.id === manifest.id);
  const target = extensionDir(manifest.id);
  if (
    previous?.sha256 === digest &&
    existsSync(target) &&
    digestOf(target) === digest
  ) {
    if (sameOrigin(previous, origin))
      return { ok: true, action: "unchanged", extension: previous };
    // The same files, now known to come from (or no longer from) a source.
    const relabeled = withOrigin(previous, origin);
    writeRegistry([
      ...installed.filter((item) => item.id !== manifest.id),
      relabeled,
    ]);
    return { ok: true, action: "unchanged", extension: relabeled };
  }
  // An update comes from where the extension was installed from. Another
  // source (a fork, a typo, a folder) may not take over its id and, with it,
  // the private data folder it keeps across updates.
  if (previous && !sameSource(previous, origin))
    throw new ExtensionError(
      "id_conflict",
      `${manifest.id} is already installed from ${
        previous.source ? "another source" : "a local folder"
      }; remove it before installing this one`,
    );
  const parent = join(extensionsRoot(), manifest.id);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(extensionDataDir(manifest.id), { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${randomBytes(6).toString("hex")}`);
  const old = join(parent, `.old-${randomBytes(6).toString("hex")}`);
  try {
    cpSync(source, staging, { recursive: true, preserveTimestamps: true });
    if (digestOf(staging) !== digest)
      throw new ExtensionError(
        "invalid_input",
        "the extension changed while it was copied; try again",
      );
    if (existsSync(target)) renameSync(target, old);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  const extension: InstalledConnectorExtension = withOrigin(
    {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir: target,
      sha256: digest,
      installedAt: new Date().toISOString(),
      connectors: manifest.connectors.map((connector) => connector.kind),
    },
    origin,
  );
  writeRegistry([
    ...installed.filter((item) => item.id !== manifest.id),
    extension,
  ]);
  return { ok: true, action: previous ? "updated" : "created", extension };
}

function sameSource(
  installed: InstalledConnectorExtension,
  origin: { source: ConnectorExtensionRepository } | undefined,
): boolean {
  return (
    JSON.stringify(installed.source ?? null) ===
    JSON.stringify(origin?.source ?? null)
  );
}

function sameOrigin(
  installed: InstalledConnectorExtension,
  origin: { source: ConnectorExtensionRepository; commit: string } | undefined,
): boolean {
  return (
    installed.commit === origin?.commit &&
    JSON.stringify(installed.source ?? null) ===
      JSON.stringify(origin?.source ?? null)
  );
}

function withOrigin(
  installed: InstalledConnectorExtension,
  origin: { source: ConnectorExtensionRepository; commit: string } | undefined,
): InstalledConnectorExtension {
  const {
    source: _source,
    commit: _commit,
    latestCommit: _latest,
    latestCheckedAt: _checked,
    ...rest
  } = installed;
  return origin
    ? {
        ...rest,
        source: origin.source,
        commit: origin.commit,
        latestCommit: origin.commit,
        latestCheckedAt: new Date().toISOString(),
      }
    : rest;
}

/**
 * Notes the commit an installed extension's source is at now (written only
 * when it moved, so the device reports it); true when it moved.
 */
export function noteLatestCommit(id: string, commit: string): boolean {
  const installed = readRegistry();
  const extension = installed.find((item) => item.id === id);
  if (!extension?.source || extension.latestCommit === commit) return false;
  writeRegistry(
    installed.map((item) =>
      item.id === id
        ? {
            ...item,
            latestCommit: commit,
            latestCheckedAt: new Date().toISOString(),
          }
        : item,
    ),
  );
  return true;
}

/** Uninstalls the extension: its files and its private folder. */
export function removeExtension(id: string): ExtensionChange {
  const installed = readRegistry();
  if (!installed.some((item) => item.id === id))
    throw new ExtensionError("not_found", `no extension ${id} is installed`);
  writeRegistry(installed.filter((item) => item.id !== id));
  rmSync(join(extensionsRoot(), id), { recursive: true, force: true });
  // The model providers its connectors gave go with it.
  saveConnectorModelProviders(
    connectorModelProviders().filter(
      (provider) => provider.connector.extensionId !== id,
    ),
  );
  return { ok: true, action: "removed" };
}

export function listExtensions(): InstalledConnectorExtension[] {
  return readRegistry();
}

/** An installed extension with its manifest, as last checked. */
export interface LoadedExtension {
  installed: InstalledConnectorExtension;
  manifest: ConnectorExtensionManifest;
}

let cache: { revision: string; loaded: LoadedExtension[] } | undefined;

/** Changes whenever an extension is added, updated or removed. */
export function extensionsRevision(): string {
  try {
    const stat = statSync(extensionsRegistryPath());
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "none";
  }
}

/**
 * The installed extensions whose manifest still reads; one that does not
 * is left out and logged (it shows up again once fixed and re-added).
 */
export function loadedExtensions(
  log: (message: string) => void = console.warn,
): LoadedExtension[] {
  const revision = extensionsRevision();
  if (cache?.revision === revision) return cache.loaded;
  const loaded: LoadedExtension[] = [];
  for (const installed of readRegistry()) {
    try {
      loaded.push({ installed, manifest: readManifest(installed.dir) });
    } catch (error) {
      log(
        `connector extension ${installed.id} is not usable: ${String(error)}`,
      );
    }
  }
  cache = { revision, loaded };
  return loaded;
}
