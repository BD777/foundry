import type {
  ConnectorDescriptor,
  ConnectorExtensionManifest,
  ConnectorExtensionRepository,
  ConnectorPackage,
  ConnectorRepositoryAccess,
  ConnectorSourceAccess,
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
const githubRepositoryPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

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
 * a program to start when any connector needs one. A connector is either
 * declarative/device-held, program-backed/device-held, or pure-data
 * server-held. The extension is always its adapter and source.
 */
export function parseExtensionManifest(
  raw: unknown,
): ConnectorExtensionManifest {
  if (!raw || typeof raw !== "object")
    fail("the manifest is not a JSON object");
  const manifest = raw as Partial<ConnectorExtensionManifest>;
  if (manifest.manifestVersion !== 1 && manifest.manifestVersion !== 2)
    fail("manifestVersion must be 1 or 2");
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
  // A program extension names its entry. A declaration-only extension has
  // none; each connector is then either `cli` (device-held) or `serverHeld`
  // (pure data).
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
  const migrationSource =
    manifest.migrationSource === undefined
      ? undefined
      : parseExtensionRepository(manifest.migrationSource);
  const seen = new Set<string>();
  const cli: Record<string, ExtensionCli> = {};
  const connectors = manifest.connectors.map((raw) => {
    const {
      cli: declared,
      accessCheck: _accessCheck,
      requirementsCheck: _requirementsCheck,
      ...connector
    } = (raw ?? {}) as ConnectorDescriptor & {
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
    const serverHeld = connector.serverHeld !== undefined;
    if (
      serverHeld &&
      (!connector.serverHeld || typeof connector.serverHeld !== "object")
    )
      fail(`${connector.kind}: serverHeld must be an object`);
    if (serverHeld && declared !== undefined)
      fail(`${connector.kind}: serverHeld connectors do not declare cli`);
    if (serverHeld) validateServerHeldDescriptor(connector);
    if (!serverHeld && entry && declared !== undefined)
      fail(
        `${connector.kind}: a connector with cli belongs to an extension without entry`,
      );
    if (!serverHeld && !entry) {
      if (declared === undefined)
        fail(
          `${connector.kind}: without entry, a connector declares cli or serverHeld`,
        );
      cli[connector.kind] = parseExtensionCli(declared, connector);
    }
    const access =
      connector.access === undefined
        ? undefined
        : parseSourceAccess(connector.access, connector.kind);
    const repositoryAccess =
      connector.repositoryAccess === undefined
        ? undefined
        : parseRepositoryAccess(connector.repositoryAccess, connector.kind);
    const packageSpec =
      connector.package === undefined
        ? undefined
        : parseConnectorPackage(connector.package, connector.kind);
    if (packageSpec && manifest.manifestVersion !== 2)
      fail(`${connector.kind}: package declarations require manifestVersion 2`);
    const descriptor: ConnectorDescriptor = {
      ...connector,
      holding: serverHeld ? "server_held" : "device_held",
      adapter: `extension:${manifest.id}`,
      tool: {
        ...(serverHeld ? {} : { source: "device" as const }),
        ...connector.tool,
      },
      ...(packageSpec ? { package: packageSpec } : {}),
      ...(access ? { access } : {}),
      ...(repositoryAccess ? { repositoryAccess } : {}),
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
    manifestVersion: manifest.manifestVersion,
    id: manifest.id!,
    name,
    version,
    protocol: manifest.protocol,
    ...(entry ? { entry } : Object.keys(cli).length > 0 ? { cli } : {}),
    connectors,
    ...(manifest.setup ? { setup: manifest.setup } : {}),
    ...(source ? { source } : {}),
    ...(migrationSource ? { migrationSource } : {}),
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

const sourceRepositoryPattern =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9_.-]{1,100}|https:\/\/[^\s@/]+\/[^\s]+)$/;

function parseSourceAccess(
  raw: unknown,
  connectorKind: string,
): ConnectorSourceAccess {
  if (!raw || typeof raw !== "object")
    fail(`${connectorKind}: access must be an object`);
  const access = raw as Partial<ConnectorSourceAccess>;
  const via = typeof access.via === "string" ? access.via.trim() : "";
  if (!kindPattern.test(via))
    fail(`${connectorKind}: access.via names a connector kind`);
  const repository =
    typeof access.repository === "string" ? access.repository.trim() : "";
  if (repository.length > 500 || !sourceRepositoryPattern.test(repository))
    fail(`${connectorKind}: access.repository is owner/repo or an https URL`);
  const hint =
    access.hint === undefined
      ? undefined
      : text(access.hint, `${connectorKind}: access.hint`, 300);
  const hints = access.hints;
  if (hints !== undefined) {
    if (!hints || typeof hints !== "object" || Array.isArray(hints))
      fail(`${connectorKind}: access.hints maps languages to text`);
    for (const [locale, value] of Object.entries(hints)) {
      if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(locale))
        fail(`${connectorKind}: access.hints names an unknown language`);
      text(value, `${connectorKind}: access.hints.${locale}`, 300);
    }
  }
  return {
    via,
    repository,
    ...(hint ? { hint } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseRepositoryAccess(
  raw: unknown,
  connectorKind: string,
): ConnectorRepositoryAccess {
  if (!raw || typeof raw !== "object")
    fail(`${connectorKind}: repositoryAccess must be an object`);
  const capability = raw as Partial<ConnectorRepositoryAccess>;
  if (
    !Array.isArray(capability.args) ||
    capability.args.length === 0 ||
    capability.args.length > 20 ||
    capability.args.some(
      (arg) => typeof arg !== "string" || !arg || arg.length > 500,
    )
  )
    fail(`${connectorKind}: repositoryAccess.args is 1-20 strings`);
  const args = capability.args as string[];
  const placeholders = args.reduce(
    (count, arg) => count + arg.split("{repository}").length - 1,
    0,
  );
  if (
    placeholders !== 1 ||
    args.some((arg) => /[{}]/.test(arg.replace("{repository}", "")))
  )
    fail(
      `${connectorKind}: repositoryAccess.args uses {repository} exactly once`,
    );
  const repositoryFormat = capability.repositoryFormat ?? "raw";
  if (repositoryFormat !== "raw" && repositoryFormat !== "github")
    fail(
      `${connectorKind}: repositoryAccess.repositoryFormat is raw or github`,
    );
  return { args, repositoryFormat };
}

const fieldIDPattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const plainIDPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const envNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const templatePattern = /\{([^{}]+)\}/g;

/**
 * The server is still the final authority, but an extension must fail at
 * install time when its server-held data cannot ever pass that authority.
 * Keep this in step with internal/connectors/descriptor_checks.go.
 */
function validateServerHeldDescriptor(descriptor: ConnectorDescriptor): void {
  const kind = descriptor.kind;
  const spec = descriptor.serverHeld as Record<string, unknown>;
  if (descriptor.signIn !== undefined)
    fail(
      `${kind}: a server-held extension declares fields, not device sign-in methods`,
    );
  if ((descriptor.requires?.length ?? 0) > 0 || descriptor.isolationEnv)
    fail(
      `${kind}: a server-held connector declares no device requirement or isolation`,
    );
  if (descriptor.repositoryAccess !== undefined)
    fail(`${kind}: repositoryAccess belongs to a device-held connector`);
  const fields = arrayValue(spec.fields, `${kind}: serverHeld.fields`, 1, 10);
  const byID = new Map<string, Record<string, unknown>>();
  for (const raw of fields) {
    if (!raw || typeof raw !== "object")
      fail(`${kind}: a serverHeld field is not an object`);
    const field = raw as Record<string, unknown>;
    const id = text(field.id, `${kind}: field id`, 32);
    if (!fieldIDPattern.test(id) || byID.has(id))
      fail(`${kind}: field id ${id} is not unique`);
    if (!["text", "secret", "url", "select"].includes(String(field.type)))
      fail(`${kind}: field ${id} has an unknown type`);
    text(field.label, `${kind}: field ${id} label`, 80);
    const options = field.options;
    const optionsFrom = field.optionsFrom;
    if (field.type === "select") {
      if (
        (Array.isArray(options) && optionsFrom !== undefined) ||
        (!Array.isArray(options) && typeof optionsFrom !== "string")
      )
        fail(
          `${kind}: field ${id} lists options or names a probe, but not both`,
        );
      if (typeof optionsFrom === "string") {
        if (
          !optionsFrom.startsWith("probe:") ||
          !plainIDPattern.test(optionsFrom.slice(6))
        )
          fail(`${kind}: field ${id} optionsFrom names a probe`);
      } else if (Array.isArray(options)) {
        if (options.length === 0 || options.length > 40)
          fail(`${kind}: field ${id} lists 1 to 40 options`);
        for (const option of options) {
          const item = objectValue(option, `${kind}: field ${id} option`);
          text(item.value, `${kind}: field ${id} option value`, 80);
          text(item.label, `${kind}: field ${id} option label`, 80);
        }
      }
    } else if (options !== undefined || optionsFrom !== undefined) {
      fail(`${kind}: only a select field lists options`);
    }
    if (field.type === "secret" && field.default !== undefined)
      fail(`${kind}: field ${id} secret has no default`);
    byID.set(id, field);
  }
  const steps = arrayValue(spec.steps, `${kind}: serverHeld.steps`, 1, 8);
  const stepped = new Set<string>();
  for (const step of steps) {
    if (!Array.isArray(step) || step.length === 0 || step.length > 10)
      fail(`${kind}: a serverHeld step names 1 to 10 fields`);
    for (const id of step) {
      if (typeof id !== "string" || !byID.has(id) || stepped.has(id))
        fail(`${kind}: serverHeld step field is unknown or repeated`);
      stepped.add(id);
    }
  }
  const probes = arrayValue(spec.probe, `${kind}: serverHeld.probe`, 1, 8);
  const probesByID = new Map<string, Record<string, unknown>>();
  for (const raw of probes) {
    if (!raw || typeof raw !== "object")
      fail(`${kind}: a serverHeld probe is not an object`);
    const probe = raw as Record<string, unknown>;
    const id = text(probe.id, `${kind}: probe id`, 32);
    if (!plainIDPattern.test(id) || probesByID.has(id))
      fail(`${kind}: serverHeld probe id ${id} is not unique`);
    if (String(probe.method).toUpperCase() !== "GET")
      fail(`${kind}: serverHeld probe ${id} uses GET`);
    checkServerPath(probe.path, `${kind}: serverHeld probe ${id}`);
    const extract =
      probe.extract === undefined
        ? {}
        : objectValue(probe.extract, `${kind}: probe ${id} extract`);
    const values = extract.values;
    if (values !== undefined) {
      if (!values || typeof values !== "object" || Array.isArray(values))
        fail(`${kind}: probe ${id} extracted values are pointers`);
      for (const [name, pointer] of Object.entries(values)) {
        if (!fieldIDPattern.test(name) || !jsonPointer(pointer))
          fail(
            `${kind}: probe ${id} extracted value is not a plain name and JSON pointer`,
          );
      }
    }
    const options = extract.options;
    if (options !== undefined) {
      const option = objectValue(options, `${kind}: probe ${id} options`);
      for (const key of ["items", "value", "label"])
        if (!jsonPointer(option[key]))
          fail(`${kind}: probe ${id} options extraction is not a JSON pointer`);
    }
    const routes = extract.routes;
    if (routes !== undefined) {
      const route = objectValue(routes, `${kind}: probe ${id} routes`);
      for (const key of ["items", "method", "path", "access"])
        if (!jsonPointer(route[key]))
          fail(`${kind}: probe ${id} routes extraction is not a JSON pointer`);
      if (route.domain !== undefined && !jsonPointer(route.domain))
        fail(`${kind}: probe ${id} domain extraction is not a JSON pointer`);
    }
    probesByID.set(id, { ...probe, extract });
  }
  for (const field of byID.values()) {
    const optionsFrom = field.optionsFrom;
    if (typeof optionsFrom !== "string") continue;
    const probe = probesByID.get(optionsFrom.slice(6));
    const extract = probe?.extract as Record<string, unknown> | undefined;
    if (!extract?.options)
      fail(
        `${kind}: field ${String(field.id)} optionsFrom extracts no options`,
      );
  }
  const upstream = objectValue(spec.upstream, `${kind}: serverHeld.upstream`);
  const baseField = byID.get(String(upstream.baseField));
  if (!baseField || baseField.type !== "url" || baseField.required !== true)
    fail(`${kind}: serverHeld.upstream.baseField names a required URL field`);
  checkServerPath(upstream.pathPrefix, `${kind}: serverHeld upstream prefix`);
  const headers = upstream.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers))
    fail(`${kind}: serverHeld upstream headers are an object`);
  const headerEntries = Object.entries(headers);
  if (headerEntries.length > 40)
    fail(`${kind}: serverHeld upstream headers lists at most 40 headers`);
  for (const [name, value] of headerEntries) {
    if (name !== canonicalHeader(name) || name === "" || name.length > 128)
      fail(
        `${kind}: serverHeld upstream header ${JSON.stringify(name)} must be written in canonical form`,
      );
    checkTemplate(
      value,
      `${kind}: serverHeld upstream header ${name}`,
      byID,
      probesByID,
      true,
      false,
    );
  }
  for (const key of [
    "requestBodyLimitBytes",
    "responseBodyLimitBytes",
    "timeoutSeconds",
  ] as const) {
    const limit = upstream[key];
    if (limit === undefined) continue;
    const maximum =
      key === "requestBodyLimitBytes"
        ? 8 << 20
        : key === "responseBodyLimitBytes"
          ? 16 << 20
          : 60;
    if (typeof limit !== "number" || limit < 0 || limit > maximum)
      fail(`${kind}: serverHeld upstream ${key} is outside its allowed range`);
  }
  const access = objectValue(spec.access, `${kind}: serverHeld.access`);
  if (typeof access.from !== "string" || !access.from.startsWith("probe:"))
    fail(`${kind}: serverHeld.access.from names a probe`);
  const accessProbe = probesByID.get(access.from.slice(6));
  const accessExtract = accessProbe?.extract as
    Record<string, unknown> | undefined;
  if (!accessProbe || !accessExtract?.routes)
    fail(`${kind}: serverHeld.access.from names a probe with route extraction`);
  if (access.default !== "deny")
    fail(`${kind}: serverHeld.access.default is deny`);
  const hasAllow = access.allow !== undefined;
  const hasAllowBy = access.allowBy !== undefined;
  if (hasAllow === hasAllowBy)
    fail(`${kind}: serverHeld.access declares exactly one of allow or allowBy`);
  if (hasAllow) {
    validateAccessLevels(access.allow, `${kind}: serverHeld.access.allow`);
  } else {
    const allowBy = objectValue(
      access.allowBy,
      `${kind}: serverHeld.access.allowBy`,
    );
    const reference = text(
      allowBy.value,
      `${kind}: serverHeld.access.allowBy.value`,
      100,
    );
    const parsed = parseProbeValueReference(reference);
    const source = parsed && probesByID.get(parsed.probe);
    const sourceExtract = source?.extract as
      Record<string, unknown> | undefined;
    const sourceValues = sourceExtract?.values as
      Record<string, unknown> | undefined;
    if (
      !parsed ||
      !sourceValues ||
      typeof sourceValues[parsed.name] !== "string"
    )
      fail(
        `${kind}: serverHeld.access.allowBy.value names a value extracted by a probe`,
      );
    const levelsByValue = objectValue(
      allowBy.map,
      `${kind}: serverHeld.access.allowBy.map`,
    );
    const mapped = Object.entries(levelsByValue);
    if (mapped.length === 0 || mapped.length > 16)
      fail(`${kind}: serverHeld.access.allowBy.map lists 1 to 16 values`);
    for (const [value, levels] of mapped) {
      if (!value || value.length > 80)
        fail(`${kind}: serverHeld.access.allowBy.map value is empty or long`);
      validateAccessLevels(
        levels,
        `${kind}: serverHeld.access.allowBy.map[${JSON.stringify(value)}]`,
      );
    }
    if (allowBy.otherwise !== undefined)
      validateAccessLevels(
        allowBy.otherwise,
        `${kind}: serverHeld.access.allowBy.otherwise`,
      );
  }
  if (spec.events !== undefined) {
    // A message channel feed (DEV-203); the server checks it in full.
    const events = objectValue(spec.events, `${kind}: serverHeld.events`);
    const poll = objectValue(events.poll, `${kind}: serverHeld.events.poll`);
    if (typeof poll.path !== "string" || !poll.path.startsWith("/"))
      fail(`${kind}: serverHeld.events.poll.path is a path`);
    const envelope = objectValue(
      events.envelope,
      `${kind}: serverHeld.events.envelope`,
    );
    objectValue(envelope.fields, `${kind}: serverHeld.events.envelope.fields`);
  }
  const session = objectValue(spec.session, `${kind}: serverHeld.session`);
  const env = session.env;
  if (!env || typeof env !== "object" || Array.isArray(env))
    fail(`${kind}: serverHeld.session.env is an object`);
  const envEntries = Object.entries(env);
  if (envEntries.length === 0 || envEntries.length > 40)
    fail(`${kind}: serverHeld.session.env lists 1 to 40 variables`);
  for (const [name, value] of envEntries) {
    if (!envNamePattern.test(name))
      fail(`${kind}: serverHeld session variable ${name} is not a plain name`);
    checkTemplate(
      value,
      `${kind}: serverHeld session variable ${name}`,
      byID,
      probesByID,
      false,
      true,
    );
  }
  const network = objectValue(spec.network, `${kind}: serverHeld.network`);
  const holdings = network.holdings;
  if (
    !Array.isArray(holdings) ||
    holdings.length < 1 ||
    holdings.length > 2 ||
    new Set(holdings).size !== holdings.length ||
    holdings.some((holding) => holding !== "server" && holding !== "device")
  )
    fail(`${kind}: serverHeld.network.holdings lists server, device or both`);
  if (holdings.includes("server") && network.publicOnly !== true)
    fail(
      `${kind}: serverHeld.network.publicOnly must be true when instances may use the server path`,
    );
}

function arrayValue(
  value: unknown,
  what: string,
  min: number,
  max: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${what} lists ${min} to ${max} entries`);
  return value;
}

function objectValue(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function checkServerPath(value: unknown, what: string): void {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 1000 ||
    /[\\\0\r\n?#]/.test(value) ||
    value.includes("..")
  )
    fail(
      `${what} is a path beginning with / without query, fragment or traversal`,
    );
}

function jsonPointer(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    (value && !value.startsWith("/"))
  )
    return false;
  return !value.split("/").some((part) => /~(?:[^01]|$)/.test(part));
}

function canonicalHeader(name: string): string {
  return name
    .split("-")
    .map((part) =>
      part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : "",
    )
    .join("-");
}

function parseProbeValueReference(
  reference: string,
): { probe: string; name: string } | undefined {
  if (!reference.startsWith("probe:")) return undefined;
  const [probe, name, extra] = reference.slice(6).split("/");
  if (
    extra !== undefined ||
    !probe ||
    !name ||
    !plainIDPattern.test(probe) ||
    !fieldIDPattern.test(name)
  )
    return undefined;
  return { probe, name };
}

function validateAccessLevels(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2)
    fail(`${what} lists 1 to 2 access levels`);
  const seen = new Set<string>();
  for (const level of value) {
    if ((level !== "read" && level !== "write") || seen.has(level))
      fail(`${what} uses read or write once each`);
    seen.add(level);
  }
}

function validProbeMap(
  expression: string,
  probes: Map<string, Record<string, unknown>>,
): boolean {
  const parts = expression.slice("probeMap:".length).split("|");
  if (parts.length < 2) return false;
  const parsed = parseProbeValueReference(`probe:${parts[0]}`);
  if (!parsed) return false;
  const probe = probes.get(parsed.probe);
  const extract = probe?.extract as Record<string, unknown> | undefined;
  const values = extract?.values as Record<string, unknown> | undefined;
  if (!values || typeof values[parsed.name] !== "string") return false;
  const seen = new Set<string>();
  for (const rule of parts.slice(1)) {
    const equals = rule.indexOf("=");
    if (equals <= 0) return false;
    const match = rule.slice(0, equals);
    const replacement = rule.slice(equals + 1);
    if (
      match.length > 80 ||
      replacement.length > 500 ||
      /[{}]|[\r\n\0]/.test(match + replacement) ||
      seen.has(match)
    )
      return false;
    seen.add(match);
  }
  return true;
}

function checkTemplate(
  value: unknown,
  what: string,
  fields: Map<string, Record<string, unknown>>,
  probes: Map<string, Record<string, unknown>>,
  allowSecret: boolean,
  allowRuntime: boolean,
): void {
  if (typeof value !== "string" || value.length > 1000)
    fail(`${what} is a bounded template`);
  let rest = value;
  for (const match of value.matchAll(templatePattern)) {
    const reference = match[1]!;
    const valid =
      (reference.startsWith("secret:") &&
        allowSecret &&
        fieldIDPattern.test(reference.slice(7)) &&
        fields.get(reference.slice(7))?.type === "secret") ||
      (reference.startsWith("field:") &&
        fieldIDPattern.test(reference.slice(6)) &&
        fields.has(reference.slice(6))) ||
      (allowRuntime &&
        reference.startsWith("probeMap:") &&
        validProbeMap(reference, probes)) ||
      (allowRuntime &&
        (reference === "gatewayBase" || reference === "standIn"));
    if (!valid) fail(`${what} uses an unknown template reference`);
    rest = rest.replace(match[0], "");
  }
  if (/[{}]/.test(rest)) fail(`${what} uses an unknown template reference`);
}

/** A package's upstream, Skill folder and repository tools, checked. */
function parseConnectorPackage(
  raw: unknown,
  connectorKind: string,
): ConnectorPackage {
  if (!raw || typeof raw !== "object")
    fail(`${connectorKind}: package must be an object`);
  const value = raw as Partial<ConnectorPackage>;
  if (!value.upstream || typeof value.upstream !== "object")
    fail(`${connectorKind}: package.upstream must be an object`);
  const via =
    typeof value.upstream.via === "string" ? value.upstream.via.trim() : "";
  if (via !== "github")
    fail(
      `${connectorKind}: package.upstream.via must name a connector that can read repositories`,
    );
  const repository =
    typeof value.upstream.repository === "string"
      ? value.upstream.repository.trim().replace(/\.git$/, "")
      : "";
  if (!githubRepositoryPattern.test(repository) || repository.length > 500)
    fail(
      `${connectorKind}: package.upstream.repository is a GitHub HTTPS repository`,
    );
  const upstreamRef = value.upstream.ref ?? "";
  if (
    typeof upstreamRef !== "string" ||
    (upstreamRef &&
      (!refPattern.test(upstreamRef) ||
        upstreamRef.startsWith("-") ||
        upstreamRef.includes("..")))
  )
    fail(`${connectorKind}: package.upstream.ref is a branch or tag name`);
  if (!value.skills || typeof value.skills !== "object")
    fail(`${connectorKind}: package.skills must be an object`);
  const skillsPath = packagePath(
    value.skills.path,
    `${connectorKind}: package.skills.path`,
  );
  if (
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    value.tools.length > 4
  )
    fail(`${connectorKind}: package.tools lists 1 to 4 tools`);
  const seen = new Set<string>();
  const tools = value.tools.map((rawTool) => {
    if (!rawTool || typeof rawTool !== "object")
      fail(`${connectorKind}: a package tool is not an object`);
    const tool = rawTool as Record<string, unknown>;
    const command = typeof tool.command === "string" ? tool.command.trim() : "";
    if (!commandNamePattern.test(command) || seen.has(command))
      fail(`${connectorKind}: package tool command is unique and plain`);
    seen.add(command);
    if (tool.source !== "repository")
      fail(
        `${connectorKind}: package tool ${command} installs from repository`,
      );
    const path = packagePath(
      tool.path,
      `${connectorKind}: package tool ${command} path`,
    );
    if (!tool.bins || typeof tool.bins !== "object" || Array.isArray(tool.bins))
      fail(`${connectorKind}: package tool ${command} bins is an object`);
    const bins = tool.bins as Record<string, unknown>;
    const names = Object.keys(bins);
    if (names.length === 0 || names.length > 32 || !names.includes(command))
      fail(
        `${connectorKind}: package tool ${command} bins includes the command`,
      );
    const cleanBins: Record<string, string> = {};
    for (const name of names) {
      if (!commandNamePattern.test(name) || typeof bins[name] !== "string")
        fail(
          `${connectorKind}: package tool ${command} bin names and paths are plain`,
        );
      cleanBins[name] = packagePath(
        bins[name],
        `${connectorKind}: package tool ${command} bin ${name}`,
      );
    }
    return {
      command,
      source: "repository" as const,
      path,
      bins: cleanBins,
    };
  });
  return {
    upstream: {
      via,
      repository,
      ...(upstreamRef ? { ref: upstreamRef } : {}),
    },
    skills: { path: skillsPath },
    tools,
  };
}

function packagePath(value: unknown, what: string): string {
  if (typeof value !== "string")
    fail(`${what} is a relative folder inside the repository`);
  const path = value.trim().replace(/\/+$/, "");
  if (
    !path ||
    path.length > 300 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(`${what} is a relative folder inside the repository`);
  return path;
}
