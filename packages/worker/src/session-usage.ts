/** Answers the server's request for a session's usage from the agent's own logs. */
import { claudeHomeCandidates, codexHomeCandidates } from "./native-chat.js";
import {
  readNativeSessionUsage,
  type NativeSessionUsage,
} from "./native-usage.js";

export async function readSessionUsage(
  payload: unknown,
): Promise<NativeSessionUsage & { error?: string }> {
  const request = (payload ?? {}) as {
    provider?: unknown;
    nativeSessionIds?: unknown;
  };
  const provider = request.provider;
  const ids = Array.isArray(request.nativeSessionIds)
    ? request.nativeSessionIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (provider !== "claude" && provider !== "codex") {
    return {
      turns: [],
      requests: [],
      error: "provider must be claude or codex",
    };
  }
  const homes =
    provider === "claude" ? claudeHomeCandidates() : codexHomeCandidates();
  const result: NativeSessionUsage = { turns: [], requests: [] };
  try {
    for (const id of ids.slice(0, 20)) {
      const usage = await readNativeSessionUsage(provider, id, homes);
      if (!usage) continue;
      result.turns.push(...usage.turns);
      result.requests.push(...usage.requests);
    }
  } catch (error) {
    return {
      ...result,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}
