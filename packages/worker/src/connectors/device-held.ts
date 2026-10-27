import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  lstatSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConnectorDescriptor,
  ConnectorAuthorizationGroup,
  ConnectorAuthorizationState,
  ConnectorAuthorizationChallenge,
  ConnectorReplyPayload,
  ConnectorRequestPayload,
  DeviceConnectorSignIn,
  DeviceConnectorState,
  DeviceConnectorUse,
} from "@bd777/foundry-protocol";
import {
  findCommand,
  installTool,
  managedToolsBin,
  npmRegistryArgs,
  toolEnvironment,
} from "../managed-tools.js";
import { errorMessage } from "../utils.js";

/**
 * Device-held connectors on this device (docs/connectors.md): the tool
 * keeps its own login here and Foundry never reads, copies or sends a
 * credential. The server names the connector by its catalog descriptor;
 * what differs between tools is a small adapter (bytedcli.ts). This module
 * finds the tool, checks the connector's requirements, installs it through
 * the managed-tools path when the person asks, runs the adapter's sign-in
 * and status commands, and tells sessions what they may use.
 */

/** One run of the tool: its output and exit code, never thrown. */
export interface ToolResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ToolRun = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ToolResult>;

/** What the adapter read of the login: no token, no email. */
export interface LoginReading {
  signedIn: boolean;
  identity?: string;
  sites?: string[];
  expiresAt?: string;
}

export interface SignInStep {
  challenge?: ConnectorAuthorizationChallenge;
  expiresAt?: string;
  status: DeviceConnectorSignIn["status"];
  verificationUrl?: string;
  userCode?: string;
  error?: string;
}

/** A tool's quirks: the commands and output a generic flow cannot know. */
export interface DeviceHeldAdapter {
  name: string;
  /** Variables for Foundry's own runs of the tool. */
  runEnvironment: Record<string, string>;
  /** Variables Foundry's own runs must not inherit. */
  clearEnvironment: string[];
  readVersion(run: ToolRun): Promise<string | undefined>;
  readLogin(run: ToolRun): Promise<LoginReading>;
  /** Starts the tool's sign-in; scratch is a private folder removed after. */
  beginSignIn(run: ToolRun, scratch: string): Promise<SignInStep>;
  pollSignIn(run: ToolRun): Promise<SignInStep>;
  signOut(run: ToolRun): Promise<void>;
  readAuthorizations?(
    run: ToolRun,
    version?: string,
  ): Promise<ConnectorAuthorizationState[]>;
  beginAuthorization?(
    run: ToolRun,
    scratch: string,
    group: ConnectorAuthorizationGroup,
  ): Promise<{ step: SignInStep; continuation?: unknown }>;
  pollAuthorization?(
    run: ToolRun,
    group: ConnectorAuthorizationGroup,
    continuation: unknown,
  ): Promise<SignInStep>;

  /** Native credential-chain isolation, applied even when the CLI is absent. */
  isolationEnvironment?(): NodeJS.ProcessEnv;

  /** The session-notes line for a session given the connector. */
  sessionNote(
    use: DeviceConnectorUse,
    command: string,
    reading: LoginReading | undefined,
  ): string;
}

export interface DeviceHeldOptions {
  adapters: Record<string, DeviceHeldAdapter>;
  /** Where Foundry's managed tools are; the default is the state root's. */
  managedBin?: () => string;
  /** Folders searched after PATH for a tool the device installed itself. */
  toolDirs?: string[];
  /** Opens a TCP connection, for tcp_reachable requirements. */
  reachable?: (host: string, port: number) => Promise<boolean>;
  /** The newest version of an npm package where the device installs from. */
  latestVersion?: (pkg: string, registry: string) => Promise<string>;
  /** Installs a managed tool (managed-tools.ts installTool). */
  install?: typeof installTool;
  now?: () => number;
}

const statusCacheMs = 30_000;
const requirementCacheMs = 5 * 60_000;
const latestCacheMs = 60 * 60_000;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Common places a person's own npm or package manager puts commands. */
function defaultToolDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
  ];
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveReach) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolveReach(ok);
    };
    socket.setTimeout(3_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function npmLatest(pkg: string, registry: string): Promise<string> {
  const npm = findCommand("npm", defaultToolDirs());
  if (!npm) return Promise.reject(new Error("npm is not on this device"));
  return new Promise((resolveVersion, reject) => {
    execFile(
      npm,
      ["view", ...npmRegistryArgs(pkg, registry), pkg, "version", "--json"],
      { env: toolEnvironment(), timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`npm view ${pkg} failed`));
          return;
        }
        try {
          const version = JSON.parse(stdout) as unknown;
          if (typeof version === "string" && versionPattern.test(version))
            resolveVersion(version);
          else reject(new Error(`npm view ${pkg} named no version`));
        } catch {
          reject(new Error(`npm view ${pkg} answered something else`));
        }
      },
    );
  });
}

interface Located {
  path: string;
  source: "foundry" | "device";
}

/** A connector's descriptor as this module needs it, checked. */
function checkedDescriptor(
  connector: ConnectorDescriptor,
): ConnectorDescriptor {
  if (connector.holding !== "device_held")
    throw new Error(`${connector.kind} is not a device-held connector`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(connector.tool?.command ?? ""))
    throw new Error(`${connector.kind} names no usable command`);
  return connector;
}

export class DeviceHeldConnectors {
  private readonly options: Required<
    Omit<DeviceHeldOptions, "toolDirs" | "managedBin">
  > & { toolDirs: string[]; managedBin: () => string };
  private readonly states = new Map<
    string,
    { at: number; state: DeviceConnectorState; reading?: LoginReading }
  >();
  private readonly requirements = new Map<
    string,
    { at: number; ok: boolean }
  >();
  private readonly latest = new Map<string, { at: number; version: string }>();
  private readonly busy = new Map<string, Promise<unknown>>();
  private readonly queued = new Map<string, number>();
  private readonly installing = new Set<string>();
  // Continuation secrets never leave this device or enter logs / state records.
  private readonly authorizationOperations = new Map<
    string,
    {
      kind: string;
      group: string;
      revision: number;
      expires: number;
      continuation: unknown;
      step: SignInStep;
      image?: string;
    }
  >();

  constructor(options: DeviceHeldOptions) {
    this.options = {
      adapters: options.adapters,
      managedBin: options.managedBin ?? managedToolsBin,
      toolDirs: options.toolDirs ?? defaultToolDirs(),
      reachable: options.reachable ?? tcpReachable,
      latestVersion: options.latestVersion ?? npmLatest,
      install: options.install ?? installTool,
      now: options.now ?? Date.now,
    };
  }

  private adapter(connector: ConnectorDescriptor): DeviceHeldAdapter {
    const adapter = this.options.adapters[connector.adapter];
    if (!adapter)
      throw new Error(
        `this worker has no adapter for ${connector.kind}; update the worker`,
      );
    return adapter;
  }

  /** The tool sessions find: Foundry's managed copy first, then the device's. */
  locate(command: string): Located | undefined {
    const managed = join(this.options.managedBin(), command);
    if (existsSync(managed)) return { path: managed, source: "foundry" };
    const own = findCommand(command, this.options.toolDirs);
    return own ? { path: own, source: "device" } : undefined;
  }

  private runner(path: string, adapter: DeviceHeldAdapter): ToolRun {
    const env: NodeJS.ProcessEnv = { ...toolEnvironment() };
    for (const name of adapter.clearEnvironment) delete env[name];
    Object.assign(env, adapter.runEnvironment, { NO_COLOR: "1" });
    return (args, options = {}) =>
      new Promise((resolveRun) => {
        execFile(
          path,
          args,
          {
            env,
            timeout: options.timeoutMs ?? 30_000,
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const failed = error as (Error & { code?: unknown }) | null;
            resolveRun({
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              code: failed
                ? typeof failed.code === "number"
                  ? failed.code
                  : 1
                : 0,
            });
          },
        );
      });
  }

  /** The first requirement this device fails, or undefined. */
  private async unmetRequirement(
    connector: ConnectorDescriptor,
    fresh: boolean,
  ): Promise<string | undefined> {
    for (const requirement of connector.requires ?? []) {
      if (requirement.kind !== "tcp_reachable")
        return `${requirement.label} (a requirement this worker cannot check)`;
      const key = `${requirement.host}:${requirement.port}`;
      const cached = this.requirements.get(key);
      let ok = cached?.ok;
      if (
        fresh ||
        !cached ||
        this.options.now() - cached.at >= requirementCacheMs
      ) {
        ok = await this.options.reachable(requirement.host, requirement.port);
        this.requirements.set(key, { at: this.options.now(), ok });
      }
      if (!ok) return requirement.label;
    }
    return undefined;
  }

  private async latestFor(
    connector: ConnectorDescriptor,
  ): Promise<string | undefined> {
    const pkg = connector.tool.package;
    if (connector.tool.source !== "npm" || !pkg) return undefined;
    const cached = this.latest.get(pkg);
    if (cached && this.options.now() - cached.at < latestCacheMs)
      return cached.version;
    try {
      const version = await this.options.latestVersion(
        pkg,
        connector.tool.registry ?? "device",
      );
      this.latest.set(pkg, { at: this.options.now(), version });
      return version;
    } catch {
      return undefined;
    }
  }

  /** Runs one action at a time per connector: the tool's login is one. */
  private serialized<T>(
    kind: string,
    action: string,
    operationId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const count = this.queued.get(kind) ?? 0;
    // One active command and at most one waiting command. Installation has a
    // longer budget, so never put authorization behind it or vice versa.
    if (
      count >= 2 ||
      this.installing.has(kind) ||
      (action === "install" && count > 0)
    )
      return Promise.reject(new Error("connector_busy"));
    this.queued.set(kind, count + 1);
    if (action === "install") this.installing.add(kind);
    const accepted = Date.now();
    const before = this.busy.get(kind) ?? Promise.resolve();
    const next = before.then(async () => {
      const started = Date.now();
      console.info("connector command", {
        kind,
        action,
        operationId,
        queueWaitMs: started - accepted,
      });
      try {
        return await work();
      } finally {
        this.queued.set(kind, (this.queued.get(kind) ?? 1) - 1);
        this.installing.delete(kind);
        console.info("connector command finished", {
          kind,
          action,
          operationId,
          elapsedMs: Date.now() - started,
        });
      }
    });
    const settled = next.catch(() => undefined);
    this.busy.set(kind, settled);
    void settled.then(() => {
      if (this.busy.get(kind) === settled) this.busy.delete(kind);
    });
    return next;
  }

  /** Reads where the connector stands here; a few seconds' cache unless fresh. */
  async status(
    connector: ConnectorDescriptor,
    fresh = false,
  ): Promise<DeviceConnectorState> {
    checkedDescriptor(connector);
    const cached = this.states.get(connector.kind);
    if (!fresh && cached && this.options.now() - cached.at < statusCacheMs)
      return cached.state;
    const state: DeviceConnectorState = {
      deviceId: "",
      kind: connector.kind,
      status: "error",
      installed: false,
      signedIn: false,
      checkedAt: new Date(this.options.now()).toISOString(),
    };
    let reading: LoginReading | undefined;
    const located = this.locate(connector.tool.command);
    if (located) {
      state.installed = true;
      state.installSource = located.source;
    }
    const unmet = await this.unmetRequirement(connector, fresh);
    if (unmet) {
      state.status = "unavailable";
      state.statusDetail = unmet;
    } else if (!located) {
      state.status = "not_installed";
    } else {
      const adapter = this.adapter(connector);
      const run = this.runner(located.path, adapter);
      try {
        state.version = await adapter.readVersion(run);
        // Independent reads share no continuation state. Keep package metadata
        // and capability discovery out of the native login's serial deadline.
        const [login] = await Promise.all([
          adapter.readLogin(run).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
          (async () => {
            if (located.source === "foundry")
              state.latestVersion = await this.latestFor(connector);
          })(),
          (async () => {
            if (!adapter.readAuthorizations) return;
            try {
              state.authorizations = await adapter.readAuthorizations(
                run,
                state.version,
              );
            } catch {
              state.authorizations = (connector.authorizationGroups ?? []).map(
                (g) => ({
                  id: g.id,
                  revision: g.revision,
                  status: "unknown",
                  verification: "not_checked",
                  checkedAt: state.checkedAt,
                  reason: "check_failed",
                }),
              );
            }
          })(),
        ]);
        if ("error" in login) throw login.error;
        reading = login.value;
        state.signedIn = reading.signedIn;
        state.status = reading.signedIn ? "ready" : "signed_out";
        if (reading.signedIn) {
          state.identity = reading.identity;
          state.sites = reading.sites;
          state.expiresAt = reading.expiresAt;
        }
      } catch (error) {
        state.status = "error";
        state.statusDetail = errorMessage(error).slice(0, 300);
      }
    }
    this.states.set(connector.kind, {
      at: this.options.now(),
      state,
      reading,
    });
    return state;
  }

  /** The last login reading of a connector, if one was made. */
  lastReading(kind: string): LoginReading | undefined {
    return this.states.get(kind)?.reading;
  }

  private async usable(
    connector: ConnectorDescriptor,
  ): Promise<{ adapter: DeviceHeldAdapter; run: ToolRun }> {
    const unmet = await this.unmetRequirement(connector, false);
    if (unmet)
      throw new Error(`${connector.label} needs ${unmet} on this device`);
    const located = this.locate(connector.tool.command);
    if (!located)
      throw new Error(`${connector.label} is not installed on this device`);
    const adapter = this.adapter(connector);
    return { adapter, run: this.runner(located.path, adapter) };
  }

  /** Installs (or upgrades to) the newest version, as a managed tool. */
  async install(connector: ConnectorDescriptor): Promise<DeviceConnectorState> {
    checkedDescriptor(connector);
    const { tool } = connector;
    if (tool.source !== "npm" || !tool.package)
      throw new Error(`${connector.label} has no package Foundry installs`);
    const unmet = await this.unmetRequirement(connector, true);
    if (unmet)
      throw new Error(`${connector.label} needs ${unmet} on this device`);
    this.latest.delete(tool.package);
    const version = await this.latestFor(connector);
    if (!version)
      throw new Error(
        `could not find the newest ${tool.package} where this device installs npm packages from`,
      );
    await this.options.install({
      name: tool.command,
      version,
      source: "npm",
      package: tool.package,
      registry: tool.registry,
    });
    return this.status(connector, true);
  }

  async signInBegin(connector: ConnectorDescriptor): Promise<SignInStep> {
    const { adapter, run } = await this.usable(checkedDescriptor(connector));
    const scratch = mkdtempSync(join(tmpdir(), "foundry-connector-"));
    try {
      return checkedStep(await adapter.beginSignIn(run, scratch));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async signInPoll(connector: ConnectorDescriptor): Promise<SignInStep> {
    const { adapter, run } = await this.usable(checkedDescriptor(connector));
    return checkedStep(await adapter.pollSignIn(run));
  }

  async signOut(connector: ConnectorDescriptor): Promise<DeviceConnectorState> {
    const { adapter, run } = await this.usable(checkedDescriptor(connector));
    await adapter.signOut(run);
    return this.status(connector, true);
  }

  private async authorization(
    request: ConnectorRequestPayload,
  ): Promise<ConnectorReplyPayload> {
    const {
      connector,
      operationId,
      authorizationId,
      authorizationRevision,
      action,
    } = request;
    const group = authorizationId
      ? connector.authorizationGroups?.find(
          (g) =>
            g.id === authorizationId && g.revision === authorizationRevision,
        )
      : { id: "", revision: 0 };

    if (!group || !operationId || !/^[a-zA-Z0-9_-]{16,100}$/.test(operationId))
      return { error: "Invalid authorization operation." };
    const now = this.options.now();
    for (const [id, op] of this.authorizationOperations)
      if (op.expires <= now) this.authorizationOperations.delete(id);
    const current = this.authorizationOperations.get(operationId);
    if (
      current &&
      (current.kind !== connector.kind ||
        current.group !== group.id ||
        current.revision !== group.revision)
    )
      return { error: "Authorization scope mismatch." };
    if (action === "sign_in_dismiss") {
      this.authorizationOperations.delete(operationId);
      return {};
    }
    const { adapter, run } = await this.usable(checkedDescriptor(connector));
    if (
      authorizationId &&
      (!adapter.beginAuthorization || !adapter.pollAuthorization)
    )
      return { error: "Update the worker to authorize this capability." };
    if (action === "sign_in_begin") {
      if (current)
        return {
          signIn: {
            ...current.step,
            operationId,
            authorizationId,
            authorizationRevision,
          },
          authorizationImage: current.image,
        };
      for (const [id, op] of this.authorizationOperations)
        if (op.kind === connector.kind && op.group === group.id)
          this.authorizationOperations.delete(id);
      const scratch = mkdtempSync(join(tmpdir(), "foundry-connector-"));
      try {
        const started = authorizationId
          ? await adapter.beginAuthorization!(
              run,
              scratch,
              group as ConnectorAuthorizationGroup,
            )
          : {
              step: await adapter.beginSignIn(run, scratch),
              continuation: undefined,
            };
        const step = checkedStep(started.step);
        let image: string | undefined;
        if (step.challenge?.kind === "qr_image") {
          const path = join(scratch, "sign-in.png");
          if (lstatSync(scratch).isSymbolicLink())
            throw new Error("Invalid authorization image.");
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 512 * 1024 || stat.size < 24)
              throw new Error("Invalid authorization image.");
            bytes = readFileSync(fd);
          } finally {
            closeSync(fd);
          }
          const width = bytes.readUInt32BE(16),
            height = bytes.readUInt32BE(20);
          if (!width || !height || width > 4096 || height > 4096)
            throw new Error("Invalid authorization image.");
          if (
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            throw new Error("Invalid authorization image.");
          image = bytes.toString("base64");
        }
        const expires = now + 5 * 60_000;
        step.expiresAt = new Date(expires).toISOString();
        this.authorizationOperations.set(operationId, {
          kind: connector.kind,
          group: group.id,
          revision: group.revision,
          continuation: started.continuation,
          step,
          image,
          expires,
        });
        const signIn = {
          ...step,
          operationId,
          authorizationId,
          authorizationRevision,
        };
        if (step.status !== "pending") {
          const saved = this.authorizationOperations.get(operationId)!;
          saved.continuation = undefined;
          saved.image = undefined;
          saved.step = {
            status: step.status,
            error: step.error,
            expiresAt: step.expiresAt,
          };
          return {
            signIn: {
              ...saved.step,
              operationId,
              authorizationId,
              authorizationRevision,
            },
          };
        }
        return { signIn, authorizationImage: image };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    if (!current)
      return {
        signIn: {
          status: "expired",
          operationId,
          authorizationId,
          authorizationRevision,
        },
      };
    if (current.step.status === "pending") {
      const step = checkedStep(
        authorizationId
          ? await adapter.pollAuthorization!(
              run,
              group as ConnectorAuthorizationGroup,
              current.continuation,
            )
          : await adapter.pollSignIn(run),
      );
      current.step =
        step.status === "pending" ? { ...current.step, ...step } : step;
      if (step.status !== "pending") {
        current.continuation = undefined;
        current.image = undefined;
      }
    }
    // Retain a terminal receipt until expiry. A lost reply must not cause a
    // consumed continuation to run again; pending replies retain the native PNG.
    return {
      signIn: {
        ...current.step,
        expiresAt: new Date(current.expires).toISOString(),
        operationId,
        authorizationId,
        authorizationRevision,
      },
      authorizationImage: current.image,
    };
  }

  /** Answers connector_request; a failure is the reply's error. */
  async handle(
    request: ConnectorRequestPayload,
  ): Promise<ConnectorReplyPayload> {
    const connector = request?.connector;
    if (!connector?.kind) return { error: "no connector named" };
    try {
      return await this.serialized(
        connector.kind,
        request.action,
        request.operationId,
        async () => {
          if (
            request.operationId &&
            ["sign_in_begin", "sign_in_poll", "sign_in_dismiss"].includes(
              request.action,
            )
          )
            return this.authorization(request);
          switch (request.action) {
            case "status":
              return { state: await this.status(connector, request.fresh) };
            case "install":
              return { state: await this.install(connector) };
            case "sign_in_begin": {
              const signIn = await this.signInBegin(connector);
              return signIn.status === "complete"
                ? { signIn, state: await this.status(connector, true) }
                : { signIn };
            }
            case "sign_in_poll": {
              const signIn = await this.signInPoll(connector);
              return signIn.status === "complete"
                ? { signIn, state: await this.status(connector, true) }
                : { signIn };
            }
            case "sign_out":
              for (const [id, op] of this.authorizationOperations)
                if (op.kind === connector.kind)
                  this.authorizationOperations.delete(id);
              return { state: await this.signOut(connector) };
            default:
              return {
                error: `unknown connector action ${String(request.action)}`,
              };
          }
        },
      );
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** The note and variables a session gets for the connectors it was sent. */
  sessionSetup(uses: DeviceConnectorUse[]): {
    environment: NodeJS.ProcessEnv;
    notes: string[];
  } {
    const environment: NodeJS.ProcessEnv = {};
    const notes: string[] = [];
    for (const use of uses) {
      const adapter = this.options.adapters[use.adapter];
      if (!adapter || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(use.command))
        continue;
      if (use.access === "none") {
        for (const [name, value] of Object.entries(use.isolationEnv ?? {}))
          if (/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) environment[name] = value;
        Object.assign(environment, adapter.isolationEnvironment?.());
      } else if (use.access !== "device_login") continue;
      const located = this.locate(use.command);
      if (!located) continue;
      // Sessions search Foundry's tools, then the worker's PATH; a tool
      // found only in another folder is named by its full path.
      const command =
        located.source === "foundry" ||
        findCommand(use.command) === located.path
          ? use.command
          : located.path;
      // Execution hosts do not share the daemon's status cache. Carry the
      // server's device reading into the note, including capability state.
      const state = use.state ?? this.states.get(use.kind)?.state;
      notes.push(
        adapter.sessionNote(
          { ...use, state },
          command,
          state ?? this.lastReading(use.kind),
        ),
      );
    }
    return { environment, notes };
  }
}

function checkedStep(step: SignInStep): SignInStep {
  const clean: SignInStep = { status: step.status };
  if (step.challenge?.kind === "qr_image")
    clean.challenge = { kind: "qr_image" };
  if (step.challenge?.kind === "local_interaction")
    clean.challenge = {
      kind: "local_interaction",
      instruction: step.challenge.instruction.slice(0, 300),
    };
  if (step.expiresAt) clean.expiresAt = step.expiresAt;
  if (step.verificationUrl) {
    const url = new URL(step.verificationUrl);
    if (url.protocol !== "https:")
      throw new Error("the sign-in page is not an https address");
    clean.verificationUrl = url.toString();
  }
  if (step.userCode) clean.userCode = step.userCode.slice(0, 64);
  if (step.error) clean.error = step.error.slice(0, 300);
  return clean;
}
