import type { AgentSessionEvent } from "@bd777/foundry-protocol";
import { registerKnownSecret } from "../secret-redaction.js";
import type { ActiveClaudeRuntime, ClaudeSDKQuery } from "../session-state.js";
import { mintTimerTurnToken } from "../session-timers.js";
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

/**
 * Gives a running Claude process a fresh Foundry token as it starts a timer's
 * turn on its own: the token of the last dispatch may have idled out. Bounded,
 * so a slow server delays the turn at most briefly; on any failure the
 * process keeps the token it has.
 */
export async function refreshClaudeFoundryTools(
  runtime: Pick<
    ActiveClaudeRuntime,
    "foundrySessionId" | "mcpServers" | "query" | "closed"
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
