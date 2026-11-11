import { timingSafeEqual } from "node:crypto";
import type {
  AgentSession,
  ExternalAccountGateway,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { readDaemonConfig } from "../platform/config.js";
import { registerKnownSecret } from "../platform/secret-redaction.js";
import { serverFetch } from "../platform/server-link/server-proxy.js";
import { deviceCredentialHeader } from "../transport/server-http.js";
import { startGatewayForwarder } from "./gateway-forwarder.js";

const handlePrefix = "fdyext_user_";

export interface ServerHeldExtensionSessionOptions {
  serverURL?: string;
  credential?: () => string | undefined;
  now?: () => number;
  renew?: (
    sessionId: string,
    provider: string,
    accountId: string,
  ) => Promise<ExternalAccountGateway>;
}

function gatewayPath(provider: string): string {
  return `/api/connectors/extensions/${encodeURIComponent(provider)}/gateway`;
}

function sessionHandlePath(provider: string): string {
  return `/api/connectors/extensions/${encodeURIComponent(provider)}/session-handle`;
}

/**
 * Gives every server-held extension tool in the session a loopback base and
 * a revocable stand-in. The real fields stay on the server; each material's
 * session templates say which variables the tool reads.
 */
export async function prepareServerHeldExtensionSession(
  session: Pick<AgentSession, "id">,
  materials: ExternalAccountMaterial[] | undefined,
  options: ServerHeldExtensionSessionOptions = {},
) {
  const environment: NodeJS.ProcessEnv = {};
  const closers: Array<() => Promise<void> | void> = [];
  if (!session.id || !options.serverURL) {
    return { environment, release: () => {} };
  }

  const firstByProvider = new Map<string, ExternalAccountMaterial>();
  for (const material of materials ?? []) {
    if (
      !material.sessionEnvironment ||
      !material.gateway ||
      !material.gateway.userHandle.startsWith(handlePrefix)
    )
      continue;
    const expected = gatewayPath(material.provider);
    if (material.gateway.path !== expected) continue;
    if (!firstByProvider.has(material.provider))
      firstByProvider.set(material.provider, material);
  }

  const credential =
    options.credential ?? (() => readDaemonConfig()?.deviceCredential?.trim());
  const now = options.now ?? Date.now;

  for (const [provider, material] of firstByProvider) {
    const path = gatewayPath(provider);
    let current = material.gateway!;
    const localHandle = current.userHandle;
    registerKnownSecret(localHandle);
    let closed = false;
    let refreshing: Promise<void> | undefined;
    const controller = new AbortController();

    async function renew() {
      if (closed) throw new Error("connector closed");
      let result: ExternalAccountGateway;
      if (options.renew) {
        result = await options.renew(session.id!, provider, material.accountId);
      } else {
        const device = credential();
        if (!device) throw new Error("device not paired");
        const response = await serverFetch(
          `${options.serverURL!.replace(/\/$/, "")}${sessionHandlePath(provider)}`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              [deviceCredentialHeader]: device,
            },
            body: JSON.stringify({
              sessionId: session.id,
              accountId: material.accountId,
            }),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20_000),
            ]),
          },
        );
        if (!response.ok) throw new Error("session handle refused");
        result = (await response.json()) as ExternalAccountGateway;
      }
      if (
        closed ||
        result.path !== path ||
        !result.userHandle?.startsWith(handlePrefix) ||
        !result.expiresAt ||
        Date.parse(result.expiresAt) <= now()
      )
        throw new Error("invalid session handle");
      registerKnownSecret(result.userHandle);
      current = result;
    }

    const forwarder = await startGatewayForwarder({
      serverURL: options.serverURL,
      gatewayPath: path,
      credential,
      allowUpgrade: false,
      authorizeHeaders: async (headers) => {
        const supplied = String(headers.authorization ?? "");
        const expected = `Bearer ${localHandle}`;
        if (
          closed ||
          supplied.length !== expected.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        )
          throw new Error("wrong session");
        const expiry = Date.parse(current.expiresAt ?? material.expiresAt);
        if (!Number.isFinite(expiry) || expiry - now() < 30_000) {
          refreshing ??= renew().finally(() => {
            refreshing = undefined;
          });
          await refreshing;
        }
        return { authorization: `Bearer ${current.userHandle}` };
      },
    });
    for (const [name, template] of Object.entries(
      material.sessionEnvironment ?? {},
    )) {
      environment[name] = template
        .replaceAll("{gatewayBase}", forwarder.baseURL)
        .replaceAll("{standIn}", localHandle);
    }
    closers.push(() => {
      closed = true;
      controller.abort();
      return forwarder.close();
    });
  }

  return {
    environment,
    release: () => {
      for (const close of closers) void close();
    },
  };
}
