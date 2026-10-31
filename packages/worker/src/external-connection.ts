/** Device-owned connection helpers. The SDK still starts the native agent itself. */
import {
  accessSync,
  constants,
  statSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isAbsolute } from "node:path";
import { spawnProcessGroup, signalChildGroup } from "./process-group.js";
import { registerKnownSecret } from "./secret-redaction.js";

export interface ExternalConnectionConfig {
  /** Absolute executable and literal arguments, never a shell command. */
  executable: string;
  args?: string[];
  /** Expected non-secret connection identity, checked on every process start. */
  identity: string;
}

export function selectedExternalConnection(profile: {
  connectionType?: string;
  externalConnection?: ExternalConnectionConfig;
  preparedExternalConfigHome?: string;
}): ExternalConnectionConfig | undefined {
  if (
    profile.connectionType !== "external" ||
    profile.preparedExternalConfigHome
  )
    return undefined;
  if (!externalConnectionAvailable(profile.externalConnection))
    throw new Error(
      "External connection helper is unavailable on this device.",
    );
  return profile.externalConnection;
}

/** External inference must never inherit another provider's credential or endpoint. */
export function externalConnectionBaseEnvironment(
  input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    const model =
      upper === "ANTHROPIC_MODEL" ||
      /^ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS)_MODEL(?:_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES)?$/.test(
        upper,
      );
    if (
      (!model &&
        /^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|API_KEY|SESSION_ACCESS_TOKEN|CLIENT_|CUSTOM_OAUTH|USE_|PROVIDER_MANAGED|CERT_STORE)|CLAUDE_GATEWAY_|GLOBAL_AGENT_)/.test(
          upper,
        )) ||
      /^(?:OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|CODEX_BASE_URL|NODE_OPTIONS|BUN_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)$/.test(
        upper,
      ) ||
      (/^OTEL_/.test(upper) && /HEADERS|TOKEN|KEY|SECRET|PASSWORD/.test(upper))
    )
      delete env[name];
  }
  return env;
}

export function externalConnectionAvailable(
  value: ExternalConnectionConfig | undefined,
): boolean {
  try {
    if (
      !value ||
      !isAbsolute(value.executable) ||
      typeof value.identity !== "string" ||
      !value.identity ||
      value.identity.length > 512 ||
      (value.args !== undefined &&
        (!Array.isArray(value.args) ||
          value.args.length > 32 ||
          value.args.some(
            (arg) =>
              typeof arg !== "string" ||
              arg.length > 4096 ||
              arg.includes("\0"),
          )))
    )
      return false;
    accessSync(value.executable, constants.X_OK);
    return statSync(value.executable).isFile();
  } catch {
    return false;
  }
}

// Helpers may change connection/telemetry settings, never executable loading,
// Foundry's configuration homes, tool grants or orchestration credentials.
function allowed(name: string): boolean {
  return (
    /^(?:ANTHROPIC_[A-Z0-9_]+|OTEL_[A-Z0-9_]+|LC_[A-Z0-9_]+)$/.test(name) ||
    [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "TZ",
      "LANG",
      "LANGUAGE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "CLAUDE_CODE_DISABLE_ARTIFACT",
      "DISABLE_GROWTHBOOK",
      "DISABLE_TELEMETRY",
      "DISABLE_ERROR_REPORTING",
    ].includes(name)
  );
}

// A helper may remove inherited runtime injection/alternate-auth settings,
// but cannot supply replacements for them or change the host's config home.
function removable(name: string): boolean {
  return (
    allowed(name) ||
    /^(?:NODE_OPTIONS|BUN_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|GLOBAL_AGENT_[A-Z_]+|CLAUDE_GATEWAY_[A-Z_]+|CLAUDE_CODE_(?:USE_[A-Z_]+|OAUTH_[A-Z_]+|API_KEY_[A-Z_]+|CLIENT_[A-Z_]+|CUSTOM_OAUTH_URL|SESSION_ACCESS_TOKEN|PROVIDER_MANAGED_BY_HOST|CERT_STORE)|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)$/.test(
      name,
    )
  );
}

export function connectionEnvironment(
  base: NodeJS.ProcessEnv,
  value: unknown,
): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object")
    throw new Error("Invalid external connection environment.");
  const { set, unset } = value as { set: unknown; unset: unknown };
  if (
    !set ||
    typeof set !== "object" ||
    Array.isArray(set) ||
    !Array.isArray(unset) ||
    Object.keys(set).length > 128 ||
    unset.length > 256
  )
    throw new Error("Invalid external connection environment.");
  const env = externalConnectionBaseEnvironment(base);
  for (const name of unset) {
    if (typeof name !== "string" || !removable(name))
      throw new Error(
        "External connection attempted to change a protected environment variable.",
      );
    delete env[name];
  }
  for (const [name, text] of Object.entries(set)) {
    if (
      !allowed(name) ||
      typeof text !== "string" ||
      text.length > 32768 ||
      text.includes("\0")
    )
      throw new Error(
        "External connection returned an invalid environment variable.",
      );
    env[name] = text;
    // Header values and credential-bearing URLs have no reliable name pattern.
    const publicValue =
      /^(?:ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_(?:HAIKU|SONNET|OPUS)_MODEL(?:_NAME|_DESCRIPTION|_SUPPORTED_CAPABILITIES)?|LANG|LANGUAGE|TZ|LC_[A-Z_]+|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|DISABLE_[A-Z_]+|CLAUDE_CODE_ENABLE_TELEMETRY|CLAUDE_CODE_DISABLE_ARTIFACT|OTEL_(?:LOGS|METRICS|TRACES)_EXPORTER)$/.test(
        name,
      );
    if (!publicValue) registerKnownSecret(text);
  }
  return env;
}

export interface PreparedExternalConnection {
  env: NodeJS.ProcessEnv;
  /** Only the helper's explicit assignments, plus host-owned proxy bypass. */
  set: Record<string, string>;
  /** Aborted when the helper disappears; a running native agent must stop. */
  signal: AbortSignal;
  release(): Promise<void>;
}

function connectionSettingsSnapshot(settings: unknown, cwd?: string): unknown {
  if (settings === undefined) return undefined;
  let value = settings;
  if (typeof value === "string") {
    const inline = value.trimStart().startsWith("{");
    const path = resolve(cwd ?? process.cwd(), value);
    if (!inline && statSync(path).size > 2 * 1024 * 1024)
      throw new Error("External connection settings exceed the size limit.");
    const text = inline ? value : readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("External connection settings exceed the size limit.");
    value = JSON.parse(text);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid external connection settings.");
  const record = value as { env?: NodeJS.ProcessEnv };
  if (
    record.env &&
    JSON.stringify(record.env) !==
      JSON.stringify(externalConnectionBaseEnvironment(record.env))
  )
    throw new Error(
      "External connection settings contain another provider's credentials or routing overrides.",
    );
  return value;
}

export async function prepareExternalConnection(
  config: ExternalConnectionConfig,
  input: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    settings?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<PreparedExternalConnection> {
  if (!externalConnectionAvailable(config))
    throw new Error(
      "External connection helper is unavailable on this device.",
    );
  input.signal?.throwIfAborted();
  const settings = connectionSettingsSnapshot(input.settings, input.cwd);
  const lost = new AbortController();
  const base = externalConnectionBaseEnvironment(input.env);
  const directory = mkdtempSync(join(tmpdir(), "foundry-connection-"));
  // Only connection-relevant values and basic OS lookup reach the helper.
  // Host paths and settings travel in the private request, not argv or logs.
  const helperEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "SYSTEMROOT"].includes(
        name,
      ),
    ),
  );
  const child = spawnProcessGroup(config.executable, config.args ?? [], {
    cwd: directory,
    env: { ...helperEnv, TMPDIR: directory },
  });
  let ended = false;
  let releasing = false;
  let cleanup: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      ended = true;
      resolve();
    }),
  );
  child.stderr.resume(); // Never relay arbitrary helper output, which may contain credentials.
  const onAbort = () => {
    signalChildGroup(child, "SIGTERM");
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  child.once("close", () => {
    input.signal?.removeEventListener("abort", onAbort);
    if (!releasing) lost.abort(new Error("External connection helper exited."));
  });
  const release = () =>
    (cleanup ??= (async () => {
      releasing = true;
      if (ended) {
        rmSync(directory, { recursive: true, force: true });
        return;
      }
      child.stdin.end();
      let force: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve) => {
        force = setTimeout(() => {
          signalChildGroup(child, "SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          resolve();
        }, 2000);
      });
      try {
        await Promise.race([closed, deadline]);
      } finally {
        clearTimeout(force!);
        input.signal?.removeEventListener("abort", onAbort);
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let bytes = Buffer.alloc(0);
        let received = false;
        const fail = () =>
          reject(
            new Error(
              "External connection preparation failed. Check the helper on the device.",
            ),
          );
        const timer = setTimeout(
          () => reject(new Error("External connection preparation timed out.")),
          input.timeoutMs ?? 15000,
        );
        const done = () => {
          clearTimeout(timer);
          child.removeListener("close", fail);
          child.removeListener("error", fail);
        };
        child.once("close", fail);
        child.once("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("data", (chunk: Buffer) => {
          if (received) return;
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 256 * 1024) {
            received = true;
            bytes = Buffer.alloc(0);
            done();
            reject(
              new Error("External connection response exceeded its limit."),
            );
            return;
          }
          const newline = bytes.indexOf(10);
          if (newline < 0) return;
          received = true;
          done();
          try {
            const value: unknown = JSON.parse(
              bytes.subarray(0, newline).toString("utf8"),
            );
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error();
            resolve(value as Record<string, unknown>);
          } catch {
            reject(new Error("External connection returned invalid JSON."));
          }
          bytes = Buffer.alloc(0);
        });
        child.stdin.write(
          JSON.stringify({
            protocol: "foundry.connection.v1",
            runtime: "claude",
            identity: config.identity,
            cwd: input.cwd,
            configHome: base.CLAUDE_CONFIG_DIR,
            settings,
            environment: Object.fromEntries(
              Object.entries(base).filter(([name]) => removable(name)),
            ),
          }) + "\n",
        );
        // A rejected preparation still clears its timer when the helper closes.
        void closed.then(done);
      },
    );
    if (
      reply.protocol !== "foundry.connection.v1" ||
      reply.identity !== config.identity
    )
      throw new Error(
        "External connection identity changed. Reconfigure this connection before starting a new session.",
      );
    if (ended || lost.signal.aborted)
      throw new Error("External connection helper exited before launch.");
    input.signal?.throwIfAborted();
    // Runtime cancellation first lets the native CLI close; release its
    // connection only after the SDK has observed the child's exit.
    input.signal?.removeEventListener("abort", onAbort);
    const env = connectionEnvironment(base, reply.environment);
    const set = {
      ...(reply.environment as { set: Record<string, string> }).set,
    };
    // The control plane's MCP bearer must not be sent through a model proxy.
    if (base.FOUNDRY_SERVER_URL) {
      const host = new URL(base.FOUNDRY_SERVER_URL).hostname;
      const bypass = [
        ...new Set(
          [
            ...(env.NO_PROXY ?? "").split(","),
            ...(env.no_proxy ?? "").split(","),
            host,
          ].filter(Boolean),
        ),
      ].join(",");
      env.NO_PROXY = set.NO_PROXY = bypass;
      env.no_proxy = set.no_proxy = bypass;
    }
    // Foundry hosts the session: the person's settings files, which Claude
    // Code now loads, may not route it past the connection (host mode).
    if (!("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" in set))
      env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
        set.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
    return {
      env,
      set,
      signal: lost.signal,
      release,
      toJSON: () => ({ identity: config.identity }),
    } as PreparedExternalConnection;
  } catch (error) {
    await release();
    throw error;
  }
}
