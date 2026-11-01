import type { AgentSessionEvent } from "@bd777/foundry-protocol";
import { registerKnownSecret } from "../secret-redaction.js";
import type { ActiveClaudeRuntime, ClaudeSDKQuery } from "../session-state.js";
import { mintTimerTurnToken } from "../session-token.js";
import { errorMessage } from "../utils.js";

/**
 * Hands a new Claude process its Foundry tools. A failure leaves the
 * session without them, as a missing token does, rather than failing it.
 */
export async function startClaudeFoundryTools(
  query: Pick<ClaudeSDKQuery, "setMcpServers">,
  servers: Record<string, unknown> | undefined,
  emit: (
    label: string,
    detail: string,
    level?: AgentSessionEvent["level"],
  ) => Promise<void> | void,
): Promise<void> {
  if (!servers || Object.keys(servers).length === 0) return;
  try {
    const result = (await query.setMcpServers?.(servers)) as
      { errors?: Record<string, string> } | undefined;
    const errors = Object.entries(result?.errors ?? {});
    if (errors.length > 0)
      await emit(
        "Foundry tools unavailable",
        errors.map(([name, error]) => `${name}: ${error}`).join("; "),
        "warning",
      );
  } catch (error) {
    await emit("Foundry tools unavailable", errorMessage(error), "warning");
  }
}

// The server keeps a session's token valid while the session is queued or
// running, and otherwise for a day after its last use (session_tokens.go).
// One installed less than this long ago was minted no earlier, so it has
// been used no earlier either: it still works when the next turn starts.
const heldTokenTrustMs = 20 * 60 * 60_000;

/**
 * Whether a reused Claude process must be handed the turn's MCP servers.
 * Each dispatch mints a new token, but the one the process holds still
 * works for the same session (see heldTokenTrustMs); handing it a new one
 * makes Claude Code reconnect the Foundry tools, 6-22 s on a slow link
 * (DEV-084). Anything else that changed, another session or an old token
 * reconnects.
 */
export function claudeToolsNeedHandOver(
  runtime: Pick<
    ActiveClaudeRuntime,
    "foundrySessionId" | "mcpServers" | "mcpServersAt"
  >,
  sessionId: string,
  next: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const held = runtime.mcpServers;
  if (!held || runtime.foundrySessionId !== sessionId) return true;
  if (
    runtime.mcpServersAt === undefined ||
    now - runtime.mcpServersAt >= heldTokenTrustMs
  )
    return true;
  return (
    JSON.stringify(withoutFoundryToken(held)) !==
    JSON.stringify(withoutFoundryToken(next))
  );
}

function withoutFoundryToken(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const foundry = servers.foundry as
    { headers?: Record<string, string> } | undefined;
  if (!foundry?.headers?.Authorization) return servers;
  const { Authorization: _token, ...headers } = foundry.headers;
  return { ...servers, foundry: { ...foundry, headers } };
}

/**
 * Gives a running Claude process a fresh Foundry token as it starts a timer's
 * turn on its own: the token of the last dispatch may have idled out. Bounded,
 * so a slow server delays the turn at most briefly; on any failure the
 * process keeps the token it has.
 */
export async function refreshClaudeFoundryTools(
  runtime: Pick<
    ActiveClaudeRuntime,
    "foundrySessionId" | "mcpServers" | "mcpServersAt" | "query" | "closed"
  >,
  mint: (sessionId: string) => Promise<string | undefined> = mintTimerTurnToken,
  timeoutMs = 10_000,
): Promise<void> {
  const foundry = runtime.mcpServers?.foundry as
    { headers?: Record<string, string> } | undefined;
  if (runtime.closed || !foundry?.headers?.Authorization) return;
  const refresh = async () => {
    const token = await mint(runtime.foundrySessionId);
    if (!token || runtime.closed || !runtime.query?.setMcpServers) return;
    registerKnownSecret(token);
    const servers = {
      ...runtime.mcpServers,
      foundry: {
        ...foundry,
        headers: { ...foundry.headers, Authorization: `Bearer ${token}` },
      },
    };
    runtime.mcpServers = servers;
    runtime.mcpServersAt = Date.now();
    await runtime.query.setMcpServers(servers);
  };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    refresh().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
