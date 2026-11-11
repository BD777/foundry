import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { deniedDevicePath, deviceFilePath } from "./files/device-files.js";
import { sessionAmbientForToken } from "./session-ambient.js";
import { registerKnownSecret } from "../platform/secret-redaction.js";
import { McpRequestPreparationError } from "../platform/server-link/server-mcp-forwarder.js";

const maxSecretFileBytes = 1024 * 1024;
const maxSecretBytes = 8 * 1024;

interface SecretFileReference {
  path: string;
  key?: string;
}

export interface PreparedConnectorInstanceRequest {
  body: Buffer;
  resolvedSecretFields: string[];
}

export class ConnectorInstanceSecretError extends McpRequestPreparationError {}

function safeReference(value: unknown, fieldID: string): SecretFileReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConnectorInstanceSecretError(
      `secretFiles.${fieldID} must contain path and optional key`,
    );
  const reference = value as Record<string, unknown>;
  if (typeof reference.path !== "string" || !reference.path.trim())
    throw new ConnectorInstanceSecretError(
      `secretFiles.${fieldID}.path is required`,
    );
  if (reference.key !== undefined && typeof reference.key !== "string")
    throw new ConnectorInstanceSecretError(
      `secretFiles.${fieldID}.key must be a string`,
    );
  return {
    path: reference.path.trim(),
    key: reference.key?.trim() || undefined,
  };
}

function namedSecretPath(
  raw: string,
  workspacePath: string | undefined,
  home: string,
): string {
  if (raw === "~" || raw.startsWith("~/") || isAbsolute(raw)) {
    const named = deviceFilePath(raw, home);
    if (!named)
      throw new ConnectorInstanceSecretError("secret file path is invalid");
    return named;
  }
  if (!workspacePath)
    throw new ConnectorInstanceSecretError(
      "relative secret file paths need a running workspace session",
    );
  return resolve(workspacePath, raw);
}

function secretFile(
  reference: SecretFileReference,
  workspacePath: string | undefined,
  home: string,
): { path: string; stat: Stats; text: string } {
  const named = namedSecretPath(reference.path, workspacePath, home);
  if (deniedDevicePath(named, home))
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} is in a denied credential-store location`,
    );
  let real: string;
  try {
    real = realpathSync(named);
  } catch {
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} does not exist`,
    );
  }
  if (deniedDevicePath(real, home))
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} resolves to a denied credential-store location`,
    );
  let stat: Stats;
  try {
    stat = statSync(real);
  } catch {
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} could not be read`,
    );
  }
  if (!stat.isFile())
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} is not a regular file`,
    );
  if (stat.size > maxSecretFileBytes)
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} is larger than ${maxSecretFileBytes} bytes`,
    );
  let data: Buffer;
  try {
    data = readFileSync(real);
  } catch {
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} could not be read`,
    );
  }
  if (data.includes(0))
    throw new ConnectorInstanceSecretError(
      `secret file ${reference.path} is binary`,
    );
  return { path: real, stat, text: data.toString("utf8") };
}

function dotenvValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2)
      throw new ConnectorInstanceSecretError(
        "dotenv value has an unclosed quote",
      );
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2)
      throw new ConnectorInstanceSecretError(
        "dotenv value has an unclosed quote",
      );
    return value
      .slice(1, -1)
      .replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
        switch (escaped) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          default:
            return escaped;
        }
      });
  }
  return value.replace(/\s+#.*$/, "").trim();
}

export function dotenvVariable(text: string, key: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match?.[1] === key) return dotenvValue(match[2] ?? "");
  }
  return undefined;
}

function resolveSecretReference(
  reference: SecretFileReference,
  workspacePath: string | undefined,
  home: string,
): string {
  const file = secretFile(reference, workspacePath, home);
  let value: string | undefined;
  if (reference.key) {
    value = dotenvVariable(file.text, reference.key);
    if (value === undefined)
      throw new ConnectorInstanceSecretError(
        `variable ${reference.key} does not exist in secret file ${reference.path}`,
      );
  } else {
    value = file.text.trim();
  }
  value = value.trim();
  if (!value)
    throw new ConnectorInstanceSecretError(
      reference.key
        ? `variable ${reference.key} in secret file ${reference.path} is empty`
        : `secret file ${reference.path} is empty`,
    );
  if (Buffer.byteLength(value, "utf8") > maxSecretBytes)
    throw new ConnectorInstanceSecretError(
      `secret from ${reference.path} is larger than ${maxSecretBytes} bytes`,
    );
  return value;
}

const secretFileTools = new Set(["connector_instances", "edge_access"]);

/**
 * Resolves the model-facing secretFiles references in one MCP request.
 * Nothing returns to the caller except the rewritten JSON: values live only
 * in this in-memory request body and the Worker redactor.
 */
export function prepareConnectorInstanceSecretRequest(
  raw: Buffer,
  authorization: string,
  options: { home?: string } = {},
): PreparedConnectorInstanceRequest | undefined {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (
    !request ||
    request.method !== "tools/call" ||
    !request.params ||
    typeof request.params !== "object"
  )
    return undefined;
  const params = request.params as Record<string, unknown>;
  if (typeof params.name !== "string" || !secretFileTools.has(params.name))
    return undefined;
  const toolName = params.name;
  if (!params.arguments || typeof params.arguments !== "object")
    throw new ConnectorInstanceSecretError(
      `${toolName} arguments must be an object`,
    );
  const args = params.arguments as Record<string, unknown>;
  if (args.secretValues !== undefined)
    throw new ConnectorInstanceSecretError(
      "secretValues is internal; use secretFiles",
    );
  if (args.secretFiles === undefined) return undefined;
  if (
    !args.secretFiles ||
    typeof args.secretFiles !== "object" ||
    Array.isArray(args.secretFiles)
  )
    throw new ConnectorInstanceSecretError(
      "secretFiles must map secret field ids to {path,key?}",
    );

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim();
  const ambient = bearer ? sessionAmbientForToken(bearer) : undefined;
  if (!ambient || ambient.connectorInstanceFiles !== true)
    throw new ConnectorInstanceSecretError(
      "secretFiles can be read only by the running session on this device",
    );

  const fields = Object.entries(args.secretFiles as Record<string, unknown>);
  if (toolName === "edge_access") {
    for (const [fieldID] of fields) {
      if (fieldID !== "clientId" && fieldID !== "clientSecret")
        throw new ConnectorInstanceSecretError(
          "edge_access secretFiles accepts only clientId and clientSecret",
        );
    }
  }
  if (fields.length === 0) {
    delete args.secretFiles;
    return {
      body: Buffer.from(JSON.stringify(request)),
      resolvedSecretFields: [],
    };
  }

  const secretValues: Record<string, string> = {};
  for (const [fieldID, rawReference] of fields) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(fieldID))
      throw new ConnectorInstanceSecretError(
        `secretFiles field id ${fieldID} is invalid`,
      );
    const value = resolveSecretReference(
      safeReference(rawReference, fieldID),
      ambient.workspacePath,
      options.home ?? homedir(),
    );
    registerKnownSecret(value);
    secretValues[fieldID] = value;
  }
  delete args.secretFiles;
  args.secretValues = secretValues;
  return {
    body: Buffer.from(JSON.stringify(request)),
    resolvedSecretFields: Object.keys(secretValues),
  };
}
