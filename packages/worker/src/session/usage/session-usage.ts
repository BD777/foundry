/**
 * Answers the server's request for native sessions' turns from the agent's
 * own logs (a personal agent's observed token budget).
 */
import {
  claudeHomeCandidates,
  codexHomeCandidates,
} from "../chat/native-chat.js";
import {
  readNativeSessionUsage,
  type NativeTurnUsage,
} from "./native-usage.js";
import { errorMessage } from "../../platform/utils.js";

export async function readSessionUsage(
  payload: unknown,
): Promise<{ turns: NativeTurnUsage[]; error?: string }> {
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
    return { turns: [], error: "provider must be claude or codex" };
  }
  const homes =
    provider === "claude" ? claudeHomeCandidates() : codexHomeCandidates();
  const turns: NativeTurnUsage[] = [];
  try {
    for (const id of ids.slice(0, 20)) {
      const usage = await readNativeSessionUsage(provider, id, homes);
      if (usage) turns.push(...usage.turns);
    }
  } catch (error) {
    return { turns, error: errorMessage(error) };
  }
  return { turns };
}
