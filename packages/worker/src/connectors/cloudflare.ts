import { timingSafeEqual } from "node:crypto";
import type {
  AgentSession,
  ExternalAccountGateway,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { readDaemonConfig } from "../platform/config.js";
import { deviceCredentialHeader } from "../transport/server-http.js";
import { registerKnownSecret } from "../platform/secret-redaction.js";
import { startGatewayForwarder } from "./gateway-forwarder.js";

const gatewayPath = "/api/connectors/cloudflare/gateway";
export interface CloudflareSessionOptions {
  serverURL?: string;
  credential?: () => string | undefined;
  now?: () => number;
  renew?: (
    sessionId: string,
    accountId: string,
  ) => Promise<ExternalAccountGateway>;
}
export async function prepareCloudflareSession(
  session: Pick<AgentSession, "id">,
  materials: ExternalAccountMaterial[] | undefined,
  options: CloudflareSessionOptions = {},
) {
  const none = {
    environment: {} as NodeJS.ProcessEnv,
    release: () => {},
  };
  if (!session.id) return none;
  const candidates = (materials ?? []).filter(
    (m) =>
      m.provider === "cloudflare" &&
      m.tool === "cf" &&
      m.gateway?.path === gatewayPath &&
      m.gateway.userHandle?.startsWith("fdycf_user_"),
  );
  // A workspace binds at most one Cloudflare identity, so the stand-in the
  // server issued for the session is the CLI's one default.
  if (candidates.length === 0) return none;
  if (!options.serverURL) return none;
  const material = candidates[0]!;
  let current = material.gateway!;
  const localHandle = current.userHandle;
  registerKnownSecret(localHandle);
  let closed = false;
  let refreshing: Promise<void> | undefined;
  const controller = new AbortController();
  const now = options.now ?? Date.now;
  const credential =
    options.credential ?? (() => readDaemonConfig()?.deviceCredential?.trim());
  async function renew() {
    if (closed) throw new Error("connector closed");
    let result: ExternalAccountGateway;
    if (options.renew)
      result = await options.renew(session.id, material.accountId);
    else {
      const device = credential();
      if (!device) throw new Error("device not paired");
      const response = await fetch(
        `${options.serverURL!.replace(/\/$/, "")}/api/connectors/cloudflare/session-handle`,
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
      result.path !== gatewayPath ||
      !result.userHandle?.startsWith("fdycf_user_") ||
      !result.expiresAt ||
      Date.parse(result.expiresAt) <= now()
    )
      throw new Error("invalid session handle");
    registerKnownSecret(result.userHandle);
    current = result;
  }
  const forwarder = await startGatewayForwarder({
    serverURL: options.serverURL,
    gatewayPath,
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
  return {
    environment: {
      CLOUDFLARE_API_TOKEN: localHandle,
      CLOUDFLARE_API_BASE_URL: `${forwarder.baseURL}/client/v4`,
      // Told only when the server found every bound zone in one account:
      // with it cf finds a zone by domain without listing accounts.
      ...(/^[a-f0-9]{32}$/.test(material.providerAccountId ?? "")
        ? { CLOUDFLARE_ACCOUNT_ID: material.providerAccountId }
        : {}),
    } as NodeJS.ProcessEnv,
    release: () => {
      closed = true;
      controller.abort();
      void forwarder.close();
    },
  };
}
