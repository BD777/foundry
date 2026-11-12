import { useEffect } from "react";
import type { AssistantSummary } from "@bd777/foundry-protocol";
import { navigateAppRoute } from "../lib/in-app-navigation";
import { parseAppRoute, type AppRoute } from "../lib/routes";
import {
  clearStoredAssistantId,
  persistAssistantId,
  storedAssistantId,
} from "./shell-preferences";
import type { AssistantDirectory } from "./use-assistants";
import type { AppLocation } from "./use-app-location";

export interface AssistantSelection {
  assistantId?: string;
  /** A legacy or stale address to correct in place. */
  destination?: AppRoute;
  /** The remembered or routed assistant no longer exists. */
  stale: boolean;
  /** The in-memory selection belongs to a deleted assistant. */
  clearSelection: boolean;
}

/**
 * The one assistant sidebar entry opens the remembered conversation, or the
 * list when this browser has no valid remembered choice.
 */
export function assistantEntryRoute(
  assistants: AssistantSummary[],
  rememberedAssistantId: string,
): AppRoute {
  const remembered = assistants.find(
    (assistant) => assistant.id === rememberedAssistantId,
  );
  return remembered
    ? { view: "assistant", assistantId: remembered.id }
    : { view: "assistants" };
}

/**
 * Which assistant the shell acts on. Explicit object routes stay explicit;
 * legacy assistant routes use only the remembered choice. Missing or deleted
 * choices open the assistant list instead of silently picking the default.
 */
export function resolveAssistantSelection(
  pathname: string,
  assistants: AssistantSummary[],
  rememberedAssistantId: string,
  selectedAssistantId?: string,
): AssistantSelection {
  if (!assistants.length) return { stale: false, clearSelection: false };
  const route = parseAppRoute(pathname);
  const remembered = assistants.find(
    (assistant) => assistant.id === rememberedAssistantId,
  );
  const selected = assistants.find(
    (assistant) => assistant.id === selectedAssistantId,
  );
  const rememberedStale = Boolean(rememberedAssistantId && !remembered);
  const selectedStale = Boolean(selectedAssistantId && !selected);

  if (route.view === "assistant" || route.view === "assistantSettings") {
    const routed = assistants.find((row) => row.id === route.assistantId);
    if (route.assistantId && !routed)
      return {
        destination: { view: "assistants" },
        stale: true,
        clearSelection: true,
      };
    const chosen =
      routed && selected && selected.id !== routed.id
        ? selected
        : (routed ?? remembered);
    if (!chosen)
      return {
        destination: { view: "assistants" },
        stale: rememberedStale,
        clearSelection: true,
      };
    return {
      assistantId: chosen.id,
      ...(chosen.id !== route.assistantId
        ? { destination: { ...route, assistantId: chosen.id } }
        : {}),
      stale: rememberedStale,
      clearSelection: selectedStale,
    };
  }

  if (route.view === "assistants") {
    const chosen = selected ?? remembered;
    return {
      ...(chosen ? { assistantId: chosen.id } : {}),
      stale: rememberedStale || selectedStale,
      clearSelection: selectedStale,
    };
  }

  const chosen = selected ?? remembered;
  return {
    ...(chosen ? { assistantId: chosen.id } : {}),
    stale: rememberedStale || selectedStale,
    clearSelection: selectedStale,
  };
}

/** Resolves aliases once the directory is known, replacing the history entry. */
export function useAssistantRouteResolution(
  location: AppLocation,
  directory: AssistantDirectory,
  userId: string,
): void {
  const { activeView, selectedAssistantId, setSelectedAssistantId } = location;
  useEffect(() => {
    if (directory.state !== "ready") return;
    const selection = resolveAssistantSelection(
      window.location.pathname,
      directory.assistants,
      storedAssistantId(userId),
      selectedAssistantId,
    );
    if (selection.stale && userId) clearStoredAssistantId(userId);
    if (selection.assistantId && selection.assistantId !== selectedAssistantId)
      setSelectedAssistantId(selection.assistantId);
    else if (
      !selection.assistantId &&
      selection.clearSelection &&
      selectedAssistantId
    )
      setSelectedAssistantId(undefined);
    if (selection.assistantId && userId)
      persistAssistantId(userId, selection.assistantId);
    if (selection.destination)
      navigateAppRoute(selection.destination, undefined, undefined, {
        replace: true,
      });
  }, [
    activeView,
    directory,
    selectedAssistantId,
    setSelectedAssistantId,
    userId,
  ]);
}
