import type {
  ConnectorDescriptor,
  ConnectorExtensionManifest,
  ConnectorExtensionRepository,
  ExtensionCli,
} from "@bd777/foundry-protocol";
import { parseExtensionCli } from "./declarative.js";
import { connectorExtensionProtocol } from "@bd777/foundry-protocol";

/**
 * Reading `foundry-extension.json` (docs/connector-extensions.md). The
 * worker checks what it needs to start the program and to name its
 * connectors safely; the server checks every descriptor again before it
 * shows or uses one (internal/connectors, ExtensionConnectors).
 */

export const manifestFileName = "foundry-extension.json";

const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const kindPattern = /^[a-z][a-z0-9-]{0,31}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const commandNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export class ExtensionManifestError extends Error {}

const gitRemotePattern =
  /^(https:\/\/[^\s@/]+\/\S+|ssh:\/\/\S+|([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*)$/;
const refPattern = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * A git folder an extension is installed from: a remote git can fetch
 * without asking anything, a folder inside it and a branch or tag.
 */
export function parseExtensionRepository(
  raw: unknown,
): ConnectorExtensionRepository {
  if (!raw || typeof raw !== "object") fail("source is not an object");
  const source = raw as Partial<ConnectorExtensionRepository>;
  const git = typeof source.git === "string" ? source.git.trim() : "";
  if (!git || git.length > 512 || !gitRemotePattern.test(git))
    fail("source.git is an https, ssh or scp-style git remote");
  const path = (source.path ?? "").replace(/^\/+|\/+$/g, "");
  if (
    typeof source.path !== "undefined" &&
    (typeof source.path !== "string" ||
      path.length > 300 ||
      path.split("/").some((part) => part === ".." || part === "."))
  )
    fail("source.path is a folder inside the repository");
  const ref = source.ref ?? "";
  if (
    typeof ref !== "string" ||
    (ref &&
      (!refPattern.test(ref) || ref.startsWith("-") || ref.includes("..")))
  )
    fail("source.ref is a branch or tag name");
  return { git, ...(path ? { path } : {}), ...(ref ? { ref } : {}) };
}

function fail(message: string): never {
  throw new ExtensionManifestError(message);
}

function text(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    fail(`${what} must be text of at most ${limit} characters`);
  return value;
}

/**
 * The manifest, checked: an id and version, a protocol this worker speaks,
 * a program to start and at least one connector. Each connector is made
 * device-held with the extension as its adapter and source.
 */
export function parseExtensionManifest(
  raw: unknown,
): ConnectorExtensionManifest {
  if (!raw || typeof raw !== "object")
    fail("the manifest is not a JSON object");
  const manifest = raw as Partial<ConnectorExtensionManifest>;
  if (manifest.manifestVersion !== 1) fail("manifestVersion must be 1");
  if (!idPattern.test(manifest.id ?? ""))
    fail(
      "id must be 1-32 lowercase letters, digits or dashes, starting with a letter",
    );
  const name = text(manifest.name, "name", 80);
  const version = text(manifest.version, "version", 64);
  if (!versionPattern.test(version)) fail("version is not a plain version");
  if (manifest.protocol !== connectorExtensionProtocol)
    fail(
      `the extension speaks protocol ${String(manifest.protocol)}; this worker speaks ${connectorExtensionProtocol}. Update the worker or the extension.`,
    );
  // A program extension names its entry; a declarative one (each
  // connector with its `cli`) has none.
  const entry =
    manifest.entry === undefined ? undefined : parseEntry(manifest.entry);
  if (!Array.isArray(manifest.connectors) || manifest.connectors.length === 0)
    fail("the extension provides no connectors");
  if (manifest.connectors.length > 8)
    fail("at most 8 connectors per extension");
  const source =
    manifest.source === undefined
      ? undefined
      : parseExtensionRepository(manifest.source);
  const seen = new Set<string>();
  const cli: Record<string, ExtensionCli> = {};
  const connectors = manifest.connectors.map((raw) => {
    const { cli: declared, ...connector } = (raw ??
      {}) as ConnectorDescriptor & {
      cli?: unknown;
    };
    if (!raw || typeof raw !== "object") fail("a connector is not an object");
    if (!kindPattern.test(connector.kind ?? "") || seen.has(connector.kind))
      fail(
        `connector kind ${String(connector.kind)} is not a unique plain name`,
      );
    seen.add(connector.kind);
    text(connector.label, `${connector.kind}: label`, 80);
    if (
      !connector.tool ||
      !commandNamePattern.test(connector.tool.command ?? "")
    )
      fail(`${connector.kind}: tool.command names the program sessions use`);
    if (entry && declared !== undefined)
      fail(
        `${connector.kind}: a connector with cli belongs to an extension without entry`,
      );
    if (!entry) {
      if (declared === undefined)
        fail(
          `${connector.kind}: without entry, each connector declares its cli`,
        );
      cli[connector.kind] = parseExtensionCli(declared, connector);
    }
    const descriptor: ConnectorDescriptor = {
      ...connector,
      holding: "device_held",
      adapter: `extension:${manifest.id}`,
      tool: { source: "device", ...connector.tool },
      extension: {
        id: manifest.id!,
        name,
        version,
        ...(source ? { source } : {}),
      },
      ...(manifest.setup ? { setup: manifest.setup } : {}),
    };
    return descriptor;
  });
  return {
    manifestVersion: 1,
    id: manifest.id!,
    name,
    version,
    protocol: manifest.protocol,
    ...(entry ? { entry } : { cli }),
    connectors,
    ...(manifest.setup ? { setup: manifest.setup } : {}),
    ...(source ? { source } : {}),
  };
}

function parseEntry(raw: unknown): { command: string; args: string[] } {
  const entry = raw as { command?: unknown; args?: unknown };
  if (!entry || typeof entry.command !== "string" || !entry.command)
    fail("entry.command names the program to start");
  const command = entry.command;
  if (
    !command.startsWith("/") &&
    !command.startsWith("${extensionDir}/") &&
    !commandNamePattern.test(command)
  )
    fail(
      'entry.command is an absolute path, "${extensionDir}/…", "node" or a command name',
    );
  if (command.includes("..")) fail("entry.command may not go up a folder");
  const args = entry.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 1024)
  )
    fail("entry.args is at most 32 strings");
  return { command, args: args as string[] };
}
