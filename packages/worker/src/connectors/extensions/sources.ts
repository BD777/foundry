import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ConnectorExtensionRepository } from "@bd777/foundry-protocol";
import {
  githubCredentialConfig,
  remoteCommit,
  withRepositoryFolder,
} from "../../skills/skill-repository-fetch.js";
import { builtinConnectorKinds } from "./builtin-kinds.js";
import {
  ExtensionManifestError,
  parseExtensionRepository,
} from "./manifest.js";
import {
  addExtension,
  ExtensionError,
  listExtensions,
  noteLatestCommit,
  type ExtensionChange,
} from "./registry.js";

/**
 * Installing an extension from the git folder it is published in
 * (docs/connector-extensions.md, "来源"), for the device's owner: from the
 * Connectors page or `foundry-worker extension add <remote>`. git runs with
 * the device's own credentials (its SSH keys, credential helpers such as
 * `gh auth git-credential`), so a private repository installs where that
 * login may read it, and says so in git's words where it may not. The
 * checkout is copied without .git and installed like a local folder, with
 * the source and commit recorded for updates.
 */

/**
 * git settings for fetching remote: a GitHub https remote also asks GitHub
 * CLI for credentials when gh is on the device (the GitHub CLI connector's
 * login), whether or not `gh auth setup-git` ran; nothing global changes.
 */
export function gitConfigFor(remote: string): string[] {
  return githubCredentialConfig(remote);
}

export function checkedRepository(raw: unknown): ConnectorExtensionRepository {
  try {
    return parseExtensionRepository(raw);
  } catch (error) {
    if (error instanceof ExtensionManifestError)
      throw new ExtensionError("invalid_input", error.message);
    throw error;
  }
}

export async function installExtensionFromRepository(
  raw: unknown,
): Promise<ExtensionChange> {
  const source = checkedRepository(raw);
  return withRepositoryFolder(
    source.git,
    source.ref,
    source.path,
    (folder, commit) => {
      const staging = mkdtempSync(join(tmpdir(), "foundry-extension-"));
      try {
        cpSync(folder, staging, {
          recursive: true,
          filter: (path) => !relative(folder, path).split(sep).includes(".git"),
        });
        return addExtension(staging, builtinConnectorKinds, { source, commit });
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
    gitConfigFor(source.git),
  );
}

/** Installs the extension again from where it came from (an update). */
export async function updateExtension(id: string): Promise<ExtensionChange> {
  const installed = listExtensions().find((item) => item.id === id);
  if (!installed)
    throw new ExtensionError("not_found", `no extension ${id} is installed`);
  if (installed.bundled)
    throw new ExtensionError(
      "invalid_input",
      `${id} updates with the Worker, not from a git source`,
    );
  if (!installed.source)
    throw new ExtensionError(
      "invalid_input",
      `${id} was installed from a local folder; add the folder again to update it`,
    );
  return installExtensionFromRepository(installed.source);
}

const lookedAt = new Map<string, number>();

/**
 * Looks (at most every maxAgeMs per extension) at the commit each installed
 * extension's source is at now; true when one moved.
 */
export async function refreshLatestCommits(maxAgeMs: number): Promise<boolean> {
  let moved = false;
  for (const extension of listExtensions()) {
    if (!extension.source) continue;
    if (Date.now() - (lookedAt.get(extension.id) ?? 0) < maxAgeMs) continue;
    lookedAt.set(extension.id, Date.now());
    try {
      const commit = await remoteCommit(
        extension.source.git,
        extension.source.ref,
        gitConfigFor(extension.source.git),
      );
      if (!commit) continue;
      if (extension.autoUpdate !== false && commit !== extension.commit) {
        const change = await installExtensionFromRepository(extension.source);
        if (change.action !== "unchanged") moved = true;
      } else if (noteLatestCommit(extension.id, commit)) moved = true;
    } catch {
      // Offline or no access right now: the last answer stands.
    }
  }
  return moved;
}
