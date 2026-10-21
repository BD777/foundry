import { timingSafeEqual } from "node:crypto";
import type {
  AgentSession,
  ExternalAccountGateway,
  ExternalAccountMaterial,
} from "@bd777/foundry-protocol";
import { readDaemonConfig } from "../config.js";
import { deviceCredentialHeader } from "../server-http.js";
import { registerKnownSecret } from "../secret-redaction.js";
import { startFeishuGatewayForwarder } from "./feishu-gateway-forwarder.js";
import { sessionTakesExternalAccounts } from "./feishu.js";

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
  session: AgentSession,
  materials: ExternalAccountMaterial[] | undefined,
  options: CloudflareSessionOptions = {},
) {
  const none = {
    environment: {} as NodeJS.ProcessEnv,
    notes: [] as string[],
    release: () => {},
  };
  if (!session.id || !sessionTakesExternalAccounts(session)) return none;
  const candidates = (materials ?? []).filter(
    (m) =>
      m.provider === "cloudflare" &&
      m.tool === "cf" &&
      m.gateway?.path === gatewayPath &&
      m.gateway.userHandle?.startsWith("fdycf_user_"),
  );
  if (!candidates.length) return none;
  if (candidates.length !== 1)
    return {
      ...none,
      notes: [
        "Cloudflare CLI has no default: select one Cloudflare identity for this workspace. The Cloudflare MCP tool selects an account explicitly.",
      ],
    };
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
  const forwarder = await startFeishuGatewayForwarder({
    serverURL: options.serverURL,
    gatewayPath,
    credential,
    methods: ["GET"],
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
    } as NodeJS.ProcessEnv,
    notes: [
      `Cloudflare identity ${material.displayName || material.label} is bound to this workspace. The Cloudflare MCP tool and official cf CLI can read only the selected zones, DNS records and certificate metadata through Foundry. cf 0.14.0 is the verified CLI version; it must be installed on this execution device. No Cloudflare credential is stored here. Do not run cf auth login/logout or change global profiles; manage authorization and zones in Foundry Connectors → Cloudflare. Access is rechecked per request and ends when this session or binding ends.`,
    ],
    release: () => {
      closed = true;
      controller.abort();
      void forwarder.close();
    },
  };
}
