import { useEffect } from "react";
import type { AssistantSummary } from "@bd777/foundry-protocol";
import { navigateAppRoute } from "../lib/in-app-navigation";
import { parseAppRoute, type AppRoute } from "../lib/routes";
import type { AssistantDirectory } from "./use-assistants";
import type { AppLocation } from "./use-app-location";

/**
 * The default assistant a legacy `/assistant…` address means, or undefined
 * when the address already names an assistant.
 */
export function defaultAssistantDestination(
  pathname: string,
  assistants: AssistantSummary[],
): AppRoute | undefined {
  const route = parseAppRoute(pathname);
  if (
    (route.view !== "assistant" && route.view !== "assistantSettings") ||
    route.assistantId
  )
    return undefined;
  const defaultAssistant = assistants.find((assistant) => assistant.isDefault);
  if (!defaultAssistant) return undefined;
  return { ...route, assistantId: defaultAssistant.id };
}

/** Resolves aliases once the directory is known, replacing the history entry. */
export function useAssistantRouteResolution(
  location: AppLocation,
  directory: AssistantDirectory,
): void {
  useEffect(() => {
    if (directory.state !== "ready") return;
    const fallback = directory.assistants.find(
      (assistant) => assistant.isDefault,
    );
    const selectedStillExists = directory.assistants.some(
      (assistant) => assistant.id === location.selectedAssistantId,
    );
    if (
      fallback &&
      (!location.selectedAssistantId ||
        (location.activeView === "assistants" && !selectedStillExists))
    )
      location.setSelectedAssistantId(fallback.id);
    const destination = defaultAssistantDestination(
      window.location.pathname,
      directory.assistants,
    );
    if (destination)
      navigateAppRoute(destination, undefined, undefined, { replace: true });
  }, [directory, location.activeView, location.selectedAssistantId]);
}
