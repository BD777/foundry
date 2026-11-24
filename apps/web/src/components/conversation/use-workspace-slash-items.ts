import { useEffect, useState } from "react";
import {
  getAgentSessionSummary,
  isAbortError,
  loadFoundryData,
} from "../../api";
import type { FoundryDataField } from "../../api-types";
import type { SlashSuggestion } from "../ui/slash-menu";
import { composerSlashItems, workspaceComposerSkills } from "./composer-slash";

const slashFields: readonly FoundryDataField[] = [
  "builtinSkills",
  "providerHealth",
  "workspaceSkills",
];

/** A native chat's id names its runtime: `native_claude_<id>` (lib/foundry-ids). */
const nativeChatProvider = (sessionId: string) =>
  /^native_(claude|codex)_/.exec(sessionId)?.[1];

async function sessionProvider(
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const native = nativeChatProvider(sessionId);
  if (native) return native;
  try {
    return (await getAgentSessionSummary(sessionId, { signal })).provider;
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Unreadable: the workspace's skills still apply, the agent's own do not.
    return undefined;
  }
}

/**
 * The "/" menu of a message to one session of a workspace that may not be
 * the one shown: that workspace's skills, and its agent's own and Foundry
 * built-in ones, as the chat composer lists them (composerSlashItems).
 */
export function useWorkspaceSlashItems({
  workspaceId,
  sessionId = "",
  enabled = true,
}: {
  workspaceId: string;
  sessionId?: string;
  enabled?: boolean;
}): SlashSuggestion[] {
  const [items, setItems] = useState<SlashSuggestion[]>([]);
  useEffect(() => {
    setItems([]);
    if (!enabled || !workspaceId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([
      loadFoundryData(workspaceId, { fields: slashFields, signal }),
      sessionProvider(sessionId, signal),
    ])
      .then(([read, provider]) => {
        if (!signal.aborted)
          setItems(
            composerSlashItems(workspaceComposerSkills(read.data), provider),
          );
      })
      .catch((error: unknown) => {
        // Without them the person can still type; the menu stays empty.
        if (!isAbortError(error)) setItems([]);
      });
    return () => controller.abort();
  }, [enabled, sessionId, workspaceId]);
  return items;
}
