/** External access-token handoff. Native Codex remains the refresh-token owner. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CodexAppServer } from "./codex-client.js";
import { nativeLoginEnvironment } from "../native-login-environment.js";
import { registerKnownSecret } from "../secret-redaction.js";

function sourceAuth(source: string): any {
  try {
    return JSON.parse(readFileSync(resolve(source, "auth.json"), "utf8"));
  } catch {
    throw new Error(
      "The selected Codex login is unavailable. Sign in using its native CLI.",
    );
  }
}
function claims(token: string): any {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
  } catch {
    return {};
  }
}
const renewals = new Map<string, Promise<void>>();
async function refresh(source: string, command: string): Promise<void> {
  let pending = renewals.get(source);
  if (!pending) {
    pending = (async () => {
      const native = new CodexAppServer(
        command,
        {
          ...Object.fromEntries(
            [
              "PATH",
              "HOME",
              "USER",
              "LOGNAME",
              "LANG",
              "LC_ALL",
              "HTTPS_PROXY",
              "HTTP_PROXY",
              "ALL_PROXY",
              "NO_PROXY",
              "https_proxy",
              "http_proxy",
              "all_proxy",
              "no_proxy",
              "SSL_CERT_FILE",
              "NODE_EXTRA_CA_CERTS",
            ]
              .filter((key) => process.env[key] !== undefined)
              .map((key) => [key, process.env[key]]),
          ),
          ...nativeLoginEnvironment("codex"),
          CODEX_HOME: source,
        },
        source,
        { initializeMs: 20000, controlMs: 20000 },
        ["-c", 'model_provider="openai"'],
      );
      try {
        await native.request("account/read", { refreshToken: true });
      } finally {
        await native.close();
      }
    })().finally(() => renewals.delete(source));
    renewals.set(source, pending);
  }
  await pending;
}
export async function authenticateIsolatedCodex(
  client: CodexAppServer,
  env: NodeJS.ProcessEnv,
  command: string,
  allowRefresh = true,
): Promise<void> {
  const source = env.FOUNDRY_CODEX_AUTH_SOURCE;
  if (!source) return;
  let auth = sourceAuth(source);
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
    registerKnownSecret(auth.OPENAI_API_KEY);
    await client.request("account/login/start", {
      type: "apiKey",
      apiKey: auth.OPENAI_API_KEY,
    });
    return;
  }
  const account = auth.tokens?.account_id;
  const tokens = async (force = false) => {
    auth = sourceAuth(source);
    if (!account || auth.tokens?.account_id !== account)
      throw new Error(
        "The selected Codex account changed; restart with the selected account.",
      );
    const expiry = claims(auth.tokens?.access_token ?? "").exp;
    if (
      force ||
      (typeof expiry === "number" && expiry * 1000 < Date.now() + 300000)
    ) {
      if (!allowRefresh)
        throw new Error(
          "Native login renewal is required; a quota read cannot renew credentials.",
        );
      await refresh(source, command);
      auth = sourceAuth(source);
    }
    if (
      !account ||
      auth.tokens?.account_id !== account ||
      !auth.tokens?.access_token
    )
      throw new Error(
        "The selected Codex account changed or expired; restart with the selected account.",
      );
    registerKnownSecret(auth.tokens.access_token);
    const plan = claims(auth.tokens.id_token ?? "")[
      "https://api.openai.com/auth"
    ]?.chatgpt_plan_type;
    return {
      accessToken: auth.tokens.access_token,
      chatgptAccountId: account,
      ...(plan ? { chatgptPlanType: plan } : {}),
    };
  };
  client.onRequest = async (method, params) => {
    if (method !== "account/chatgptAuthTokens/refresh")
      throw new Error("Unsupported native request");
    if (params?.previousAccountId && params.previousAccountId !== account)
      throw new Error("The native account changed; refresh refused.");
    return tokens(true);
  };
  await client.request("account/login/start", {
    type: "chatgptAuthTokens",
    ...(await tokens()),
  });
}
