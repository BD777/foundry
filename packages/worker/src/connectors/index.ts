import type {
  AgentSession,
  ConnectorDescriptor,
  ConnectorReplyPayload,
  ConnectorRequestPayload,
  DeviceConnectorUse,
  ExtensionReplyPayload,
  ExtensionRequestPayload,
  ExternalAccountMaterial,
  SessionToolPin,
} from "@bd777/foundry-protocol";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { foundryStatePath } from "../platform/state-root.js";
import { prepareAppStoreConnectSession } from "./appstoreconnect.js";
import { prepareCloudflareSession } from "./cloudflare.js";
import { prepareServerHeldExtensionSession } from "./server-held-extension.js";
import { requestExtensionUpstream } from "./extension-network.js";
import {
  applySessionSetup,
  mergeEnvironment,
  pruneSessionFolders,
} from "./session-environment.js";
import { awsAdapter } from "./aws.js";
import { githubAdapter } from "./github.js";
import { tencentCloudAdapter } from "./tencentcloud.js";
import { alibabaCloudAdapter } from "./alibabacloud.js";
import {
  DeviceHeldConnectors,
  type ConnectorRequestHooks,
} from "./device-held.js";
import {
  extensionAdapter,
  type ExtensionDeviceHeldAdapter,
} from "./extensions/adapter.js";
import { ExtensionHost } from "./extensions/host.js";
import {
  modelAccessHasProblems,
  refreshExtensionModelProviders,
} from "./extensions/model-access.js";
import {
  bundledVersionNewerThanLocal,
  bundledExtensions,
  extensionsRevision,
  installBundledExtension,
  loadedExtensions,
  removeExtension,
  setExtensionAutoUpdate,
  syncBundledExtensions,
} from "./extensions/registry.js";
import {
  installExtensionFromRepository,
  refreshLatestCommits,
} from "./extensions/sources.js";

export type { ExternalAccountsOptions } from "./feishu.js";
export {
  addExtension,
  bundledExtensions,
  ExtensionError,
  installBundledExtension,
  listExtensions,
  removeExtension,
  setExtensionAutoUpdate,
  syncBundledExtensions,
} from "./extensions/registry.js";
export { builtinConnectorKinds } from "./extensions/builtin-kinds.js";
export {
  installExtensionFromRepository,
  updateExtension,
} from "./extensions/sources.js";
export { extensionsRevision };
import {
  materializeSessionAccounts,
  reapExternalAccountProfiles,
  sessionExternalAccountEnvironment,
  type ExternalAccountsOptions,
} from "./feishu.js";

/**
 * The Connectors module on the worker (docs/connectors.md, "模块边界"). The
 * rest of the worker uses only this file: preparing and releasing a
 * session's connectors, the session's variables, reaping what a
 * crashed process left, and answering connector_request. Server-held
 * connectors (Feishu: feishu.ts, gateway-forwarder.ts) and
 * device-held ones (device-held.ts with an adapter per tool: aws.ts, or an
 * installed extension's, extensions/) stay behind it.
 */

/**
 * Installed connector extensions' processes (extensions/host.ts). A login
 * an extension reports changed is read again, and model access is listed
 * again.
 */
export const extensionHost = new ExtensionHost({
  log: (message) => console.warn(message),
  onChanged: (_extensionId, kind) => {
    deviceHeldConnectors.invalidate(kind);
    void refreshModelAccess();
  },
});

const extensionAdapters = new Map<string, ExtensionDeviceHeldAdapter>();

/** The device-held connectors' adapters, by the catalog's adapter name. */
export const deviceHeldConnectors = new DeviceHeldConnectors({
  adapters: {
    aws: awsAdapter,
    github: githubAdapter,
    tencentcloud: tencentCloudAdapter,
    alibabacloud: alibabaCloudAdapter,
  },
  extensionAdapter: (connector) => {
    const id = connector.adapter.slice("extension:".length);
    const installed = extensionHost.extension(id);
    if (
      !installed?.manifest.connectors.some(
        (item) => item.kind === connector.kind,
      )
    )
      return undefined;
    const key = `${id}\0${connector.kind}\0${installed.installed.sha256}`;
    let adapter = extensionAdapters.get(key);
    if (!adapter) {
      adapter = extensionAdapter(extensionHost, connector);
      extensionAdapters.set(key, adapter);
    }
    return adapter;
  },
});

/**
 * The connectors the device's installed extensions provide, as its
 * registration reports them (the server checks them again).
 */
export function extensionConnectorDescriptors(): ConnectorDescriptor[] {
  const installed = loadedExtensions();
  const installedIDs = new Set(installed.map(({ manifest }) => manifest.id));
  const fromInstalled = installed.flatMap(({ installed, manifest }) => {
    // A local folder install that stayed in place because it is newer than
    // this Worker's copy tells the page why it did not switch.
    const bundledVersion =
      !installed.bundled && !installed.source
        ? bundledVersionNewerThanLocal(manifest.id, manifest.version)
        : undefined;
    return manifest.connectors.map((connector) => ({
      ...connector,
      extension: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        state: "installed" as const,
        ...(installed.bundled ? { bundled: true } : {}),
        ...(bundledVersion ? { bundledVersion } : {}),
        ...(installed.autoUpdate !== undefined
          ? { autoUpdate: installed.autoUpdate }
          : installed.source
            ? { autoUpdate: true }
            : {}),
        // Where this copy came from wins over what the manifest names.
        ...((installed.source ?? manifest.source)
          ? { source: installed.source ?? manifest.source }
          : {}),
        ...(installed.commit ? { commit: installed.commit } : {}),
        ...(installed.latestCommit
          ? { latestCommit: installed.latestCommit }
          : {}),
      },
    }));
  });
  const available = bundledExtensions()
    .filter(({ manifest }) => !installedIDs.has(manifest.id))
    .flatMap(({ manifest }) =>
      manifest.connectors.map((connector) => ({
        ...connector,
        extension: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          bundled: true,
          state: "available" as const,
        },
      })),
    );
  return [...fromInstalled, ...available];
}

let modelAccessRefresh: Promise<boolean> | undefined;

/** Lists model access again (one refresh at a time); true when it changed. */
export function refreshModelAccess(): Promise<boolean> {
  modelAccessRefresh ??= refreshExtensionModelProviders(extensionHost).finally(
    () => {
      modelAccessRefresh = undefined;
    },
  );
  return modelAccessRefresh;
}

const modelAccessIntervalMs = 5 * 60_000;
/** How soon a provider listed as not usable now is asked again. */
const modelAccessRetryMs = 60_000;
/** How often an installed extension's source is asked for a newer commit. */
const sourceCheckIntervalMs = 6 * 60 * 60_000;
const extensionWatchMs = 20_000;
let maintenance: NodeJS.Timeout | undefined;

/**
 * While the worker runs: keeps model access current (every few minutes,
 * and at once when an extension is added, updated or removed) and ends
 * processes of extensions that were removed. Call once when the daemon
 * starts.
 */
export function startConnectorExtensions(workerVersion: string): () => void {
  if (maintenance) return () => undefined;
  extensionHost.workerVersion = workerVersion;
  syncBundledExtensions();
  let seen = "";
  let listedAt = 0;
  const tick = () => {
    const revision = extensionsRevision();
    const changed = revision !== seen;
    seen = revision;
    if (changed) extensionHost.prune();
    void refreshLatestCommits(sourceCheckIntervalMs).catch(() => undefined);
    const interval = modelAccessHasProblems()
      ? modelAccessRetryMs
      : modelAccessIntervalMs;
    if (!changed && Date.now() - listedAt < interval) return;
    listedAt = Date.now();
    if (
      changed ||
      loadedExtensions().some((item) =>
        item.manifest.connectors.some((c) => c.provides?.modelAccess),
      )
    )
      void refreshModelAccess().catch(() => undefined);
  };
  tick();
  maintenance = setInterval(tick, extensionWatchMs);
  maintenance.unref();
  return () => {
    clearInterval(maintenance);
    maintenance = undefined;
    extensionHost.stopAll();
  };
}

const environmentBySession = new Map<string, NodeJS.ProcessEnv>();
/** The session's own folder of linked tools, first on its PATH. */
const binDirBySession = new Map<string, string>();
/**
 * The latest run of each session that set up its connectors. A run held
 * for its agent's own work may end after a newer run of the session took
 * over its variables and tool folder, and must then leave them.
 */
const preparedBySession = new Map<string, object>();
const sessionBinRoot = () => foundryStatePath("session-bin");
const staleSessionBinMs = 7 * 24 * 60 * 60_000;

export interface SessionConnectorsInput {
  externalAccounts?: ExternalAccountMaterial[];
  deviceConnectors?: DeviceConnectorUse[];
  /** The tool versions the session runs and whether their checks passed. */
  toolPins?: SessionToolPin[];
}

export interface PreparedConnectors {
  release(): void;
}

/**
 * Sets up what run_session carried for the session's connectors (the
 * server alone decides which sessions get any: connectors.takesConnectors);
 * call the release when the session's run ends, whatever the outcome, or
 * once the agent process it left running exits (holdWhileAgentRuns).
 * A newer run of the session takes over its profiles, variables and tool
 * folder; an older run's release then leaves them.
 */
export async function prepareSessionConnectors(
  session: Pick<AgentSession, "id">,
  input: SessionConnectorsInput,
  options: ExternalAccountsOptions = {},
): Promise<PreparedConnectors> {
  const accounts = await materializeSessionAccounts(
    session,
    input.externalAccounts,
    { ...options, toolPins: input.toolPins ?? options.toolPins },
  );
  const cloudflare = await prepareCloudflareSession(
    session,
    input.externalAccounts,
    { serverURL: options.serverURL },
  );
  const appStoreConnect = await prepareAppStoreConnectSession(
    session,
    input.externalAccounts,
    { serverURL: options.serverURL },
  );
  const serverHeldExtensions = await prepareServerHeldExtensionSession(
    session,
    input.externalAccounts,
    { serverURL: options.serverURL },
  );
  const serverHeldEnvironment = mergeEnvironment(
    mergeEnvironment(cloudflare.environment, appStoreConnect.environment),
    serverHeldExtensions.environment,
  );
  const run = {};
  if (session.id) {
    preparedBySession.set(session.id, run);
    environmentBySession.delete(session.id);
    binDirBySession.delete(session.id);
    if (Object.keys(serverHeldEnvironment).length)
      environmentBySession.set(session.id, serverHeldEnvironment);
  }
  const uses = Array.isArray(input.deviceConnectors)
    ? input.deviceConnectors
    : [];
  let binDir: string | undefined;
  if (session.id && uses.length > 0) {
    // The one place a session's device-held connectors are set up: the tool
    // linked into the session's own bin folder, the adapters' variables, and
    // the isolation of a connector it may not use.
    pruneSessionFolders(sessionBinRoot(), staleSessionBinMs);
    binDir = join(sessionBinRoot(), safeFolderName(session.id));
    rmSync(binDir, { recursive: true, force: true });
    const { environment, pathDirs } = deviceHeldConnectors.sessionSetup(
      uses,
      binDir,
    );
    if (Object.keys(environment).length > 0)
      environmentBySession.set(
        session.id,
        mergeEnvironment(
          environmentBySession.get(session.id) ?? {},
          environment,
        ),
      );
    if (pathDirs.length > 0) binDirBySession.set(session.id, binDir);
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      accounts.release();
      cloudflare.release();
      appStoreConnect.release();
      serverHeldExtensions.release();
      if (session.id && preparedBySession.get(session.id) === run) {
        preparedBySession.delete(session.id);
        environmentBySession.delete(session.id);
        binDirBySession.delete(session.id);
        if (binDir) rmSync(binDir, { recursive: true, force: true });
      }
    },
  };
}

/** The variables a session's processes get for its connectors. */
export function sessionConnectorEnvironment(
  sessionId: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...sessionExternalAccountEnvironment(sessionId),
    ...((sessionId && environmentBySession.get(sessionId)) || {}),
  };
}

/**
 * `env` as the session's processes have it with its connectors: their
 * variables added (git settings join the session's own) and the folder of
 * the tools linked for it first on PATH.
 */
export function withSessionConnectors(
  env: NodeJS.ProcessEnv,
  sessionId: string | undefined,
): NodeJS.ProcessEnv {
  const binDir = sessionId ? binDirBySession.get(sessionId) : undefined;
  return applySessionSetup(env, {
    environment: sessionConnectorEnvironment(sessionId),
    pathDirs: binDir ? [binDir] : [],
  });
}

export interface ConnectorCheckEnvironment {
  /** The variables a session with these accounts gets (FEISHU_PROFILE…). */
  environment: NodeJS.ProcessEnv;
  release(): void;
}

/**
 * The environment a session with these server-held accounts gets, for a
 * tool version check (check_tool) rather than a session: the same profiles
 * and forwarders under a one-off id, removed by the release. Undefined when
 * none of the accounts could be set up.
 */
export async function prepareConnectorCheck(
  externalAccounts: ExternalAccountMaterial[],
  options: ExternalAccountsOptions = {},
): Promise<ConnectorCheckEnvironment | undefined> {
  const check = { id: `check_${randomUUID()}` };
  const prepared = await prepareSessionConnectors(
    check,
    { externalAccounts },
    options,
  );
  const environment = sessionConnectorEnvironment(check.id);
  if (Object.keys(environment).length === 0) {
    prepared.release();
    return undefined;
  }
  return { environment, release: () => prepared.release() };
}

/** A session id as one plain folder name. */
function safeFolderName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/** Removes what an earlier worker process set up for sessions and left. */
export function reapConnectorLeftovers(log: (message: string) => void): void {
  reapExternalAccountProfiles({ log });
}

/** Answers the server's connector_request; hooks report on the way. */
export async function handleConnectorRequest(
  request: ConnectorRequestPayload,
  hooks?: ConnectorRequestHooks,
): Promise<ConnectorReplyPayload> {
  if (request.action === "extension_request") {
    if (!request.extension) return { error: "no extension request" };
    try {
      return { extension: await requestExtensionUpstream(request.extension) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const reply = await deviceHeldConnectors.handle(request, hooks);
  // A model-access login that was read, signed in or out may give the
  // device different model providers.
  if (request.connector?.provides?.modelAccess && reply.state)
    void refreshModelAccess().catch(() => undefined);
  return reply;
}

/**
 * Answers the server's extension_request, which only the device's owner
 * makes: install or update an extension from a git folder, or remove one.
 */
export async function handleExtensionRequest(
  request: ExtensionRequestPayload,
): Promise<ExtensionReplyPayload> {
  try {
    if (request?.action === "install") {
      const change = request.bundledExtensionId
        ? installBundledExtension(request.bundledExtensionId)
        : await installExtensionFromRepository(request.source);
      return { action: change.action, extension: change.extension };
    }
    if (request?.action === "remove" && request.extensionId) {
      const change = removeExtension(request.extensionId);
      extensionHost.prune();
      return { action: change.action };
    }
    if (
      request?.action === "set-auto-update" &&
      request.extensionId &&
      typeof request.autoUpdate === "boolean"
    ) {
      const extension = setExtensionAutoUpdate(
        request.extensionId,
        request.autoUpdate,
      );
      return { action: "updated", extension };
    }
    return { error: `unknown extension action ${String(request?.action)}` };
  } catch (error) {
    return {
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1500,
      ),
    };
  }
}
