import { serverFetch } from "./server-proxy.js";
import { daemonRequestHeaders } from "./server-http.js";

let tokenServerURL: string | undefined;

/** The server that mints this worker's session tokens. */
export function configureSessionTokens(serverURL: string): void {
  tokenServerURL = serverURL;
}

/**
 * A fresh Foundry token for a session whose Claude process fires a timer
 * itself: no dispatch mints one for that turn, and the token the process
 * holds may have idled out. Undefined where this worker has no server (a
 * sandboxed session) or the server refuses.
 */
export async function mintTimerTurnToken(
  sessionId: string,
): Promise<string | undefined> {
  if (!tokenServerURL) return undefined;
  try {
    const response = await serverFetch(
      `${tokenServerURL}/api/daemon/sessions/${encodeURIComponent(sessionId)}/session-tokens`,
      { method: "POST", headers: daemonRequestHeaders(true) },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { sessionToken?: unknown };
    return typeof body.sessionToken === "string" && body.sessionToken
      ? body.sessionToken
      : undefined;
  } catch {
    return undefined;
  }
}
