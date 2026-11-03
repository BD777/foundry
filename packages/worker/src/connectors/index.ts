import type {
  AgentSession,
  ConnectorDescriptor,
  ConnectorReplyPayload,
  ConnectorRequestPayload,
  DeviceConnectorUse,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { prepareCloudflareSession } from "./cloudflare.js";
import { awsAdapter } from "./aws.js";
import {
  DeviceHeldConnectors,
  type ConnectorRequestHooks,
} from "./device-held.js";
import {
  extensionAdapter,
  type ExtensionDeviceHeldAdapter,
} from "./extensions/adapter.js";
import { ExtensionHost } from "./extensions/host.js";
import { refreshExtensionModelProviders } from "./extensions/model-access.js";
import { extensionsRevision, loadedExtensions } from "./extensions/registry.js";

export {
  addExtension,
  ExtensionError,
  listExtensions,
  removeExtension,
} from "./extensions/registry.js";
export { builtinConnectorKinds } from "./extensions/builtin-kinds.js";
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
 * connectors (Feishu: feishu.ts, feishu-gateway-forwarder.ts) and
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
  adapters: { aws: awsAdapter },
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
  return loadedExtensions().flatMap(
    (extension) => extension.manifest.connectors,
  );
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
  let seen = "";
  let listedAt = 0;
  const tick = () => {
    const revision = extensionsRevision();
    const changed = revision !== seen;
    seen = revision;
    if (changed) extensionHost.prune();
    if (!changed && Date.now() - listedAt < modelAccessIntervalMs) return;
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

export interface SessionConnectorsInput {
  externalAccounts?: ExternalAccountMaterial[];
  deviceConnectors?: DeviceConnectorUse[];
}

export interface PreparedConnectors {
  release(): void;
}

/**
 * Sets up what run_session carried for the session's connectors (the
 * server alone decides which sessions get any: connectors.takesConnectors);
 * call the release when the session's run ends, whatever the outcome.
 */
export async function prepareSessionConnectors(
  session: AgentSession,
  input: SessionConnectorsInput,
  options: ExternalAccountsOptions = {},
): Promise<PreparedConnectors> {
  const accounts = await materializeSessionAccounts(
    session,
    input.externalAccounts,
    options,
  );
  const cloudflare = await prepareCloudflareSession(
    session,
    input.externalAccounts,
    { serverURL: options.serverURL },
  );
  if (session.id) {
    if (Object.keys(cloudflare.environment).length)
      environmentBySession.set(session.id, cloudflare.environment);
  }
  const uses = Array.isArray(input.deviceConnectors)
    ? input.deviceConnectors
    : [];
  if (session.id && uses.length > 0) {
    const { environment } = deviceHeldConnectors.sessionSetup(uses);
    if (Object.keys(environment).length > 0)
      environmentBySession.set(session.id, {
        ...environmentBySession.get(session.id),
        ...environment,
      });
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      accounts.release();
      cloudflare.release();
      if (session.id) {
        environmentBySession.delete(session.id);
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

/** Removes what an earlier worker process set up for sessions and left. */
export function reapConnectorLeftovers(log: (message: string) => void): void {
  reapExternalAccountProfiles({ log });
}

/** Answers the server's connector_request; hooks report on the way. */
export async function handleConnectorRequest(
  request: ConnectorRequestPayload,
  hooks?: ConnectorRequestHooks,
): Promise<ConnectorReplyPayload> {
  const reply = await deviceHeldConnectors.handle(request, hooks);
  // A model-access login that was read, signed in or out may give the
  // device different model providers.
  if (request.connector?.provides?.modelAccess && reply.state)
    void refreshModelAccess().catch(() => undefined);
  return reply;
}
