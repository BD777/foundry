import type {
  AgentSession,
  ConnectorReplyPayload,
  ConnectorRequestPayload,
  DeviceConnectorUse,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { prepareCloudflareSession } from "./cloudflare.js";
import { bytedcliAdapter } from "./bytedcli.js";
import { DeviceHeldConnectors } from "./device-held.js";
import {
  materializeSessionAccounts,
  reapExternalAccountProfiles,
  sessionExternalAccountEnvironment,
  sessionExternalAccountNote,
  sessionTakesExternalAccounts,
  type ExternalAccountsOptions,
} from "./feishu.js";

/**
 * The Connectors module on the worker (docs/connectors.md, "模块边界"). The
 * rest of the worker uses only this file: preparing and releasing a
 * session's connectors, the session's variables and notes, reaping what a
 * crashed process left, and answering connector_request. Server-held
 * connectors (Feishu: feishu.ts, feishu-gateway-forwarder.ts) and
 * device-held ones (device-held.ts with an adapter per tool, bytedcli.ts)
 * stay behind it.
 */

/** The device-held connectors' adapters, by the catalog's adapter name. */
export const deviceHeldConnectors = new DeviceHeldConnectors({
  adapters: { bytedcli: bytedcliAdapter },
});

const environmentBySession = new Map<string, NodeJS.ProcessEnv>();
const notesBySession = new Map<string, string>();

export interface SessionConnectorsInput {
  externalAccounts?: ExternalAccountMaterial[];
  deviceConnectors?: DeviceConnectorUse[];
}

export interface PreparedConnectors {
  release(): void;
}

/**
 * Sets up what run_session carried for the session's connectors; call the
 * release when the session's run ends, whatever the outcome.
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
    if (cloudflare.notes.length)
      notesBySession.set(session.id, cloudflare.notes.join("\n"));
  }
  const uses = Array.isArray(input.deviceConnectors)
    ? input.deviceConnectors
    : [];
  if (session.id && uses.length > 0 && sessionTakesExternalAccounts(session)) {
    const { environment, notes } = deviceHeldConnectors.sessionSetup(uses);
    if (Object.keys(environment).length > 0)
      environmentBySession.set(session.id, {
        ...environmentBySession.get(session.id),
        ...environment,
      });
    if (notes.length > 0)
      notesBySession.set(
        session.id,
        [notesBySession.get(session.id), ...notes].filter(Boolean).join("\n"),
      );
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
        notesBySession.delete(session.id);
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

/** The session-notes lines naming a session's connectors (never a credential). */
export function sessionConnectorNote(sessionId: string | undefined): string {
  return [
    sessionExternalAccountNote(sessionId),
    (sessionId && notesBySession.get(sessionId)) || "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Removes what an earlier worker process set up for sessions and left. */
export function reapConnectorLeftovers(log: (message: string) => void): void {
  reapExternalAccountProfiles({ log });
}

/** Answers the server's connector_request. */
export function handleConnectorRequest(
  request: ConnectorRequestPayload,
): Promise<ConnectorReplyPayload> {
  return deviceHeldConnectors.handle(request);
}
