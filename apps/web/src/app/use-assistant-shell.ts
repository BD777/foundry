import { useEffect, useRef, useState } from "react";
import type { PersonalAgent } from "@bd777/foundry-protocol";
import {
  getPersonalAgent,
  isPersonalAgentUnavailable,
  updatePersonalAgentSettings,
} from "../api";
import type { InterfaceMode } from "../lib/assistant-settings-sections";
import {
  forgetStoredInterfaceMode,
  isLandingPath,
  pathForAppRoute,
  storedInterfaceMode,
} from "./navigation";
import type { AppLocation } from "./use-app-location";

const modeOf = (agent: PersonalAgent): InterfaceMode =>
  agent.settings.simpleInterface ? "simple" : "full";

/**
 * What the person's assistant decides about the shell (§10), read once:
 *
 * - Opening Foundry (the bare URL) lands on the assistant. It turns back to
 *   the workspace, in the same history entry, when the assistant's home
 *   page setting says not to or the server has no assistant. The active
 *   workspace is never touched.
 * - The interface (full or simple) is the assistant's simpleInterface
 *   setting. A choice this browser kept from before is carried over to the
 *   server once and then forgotten; until there is an assistant to hold
 *   it, it still applies here.
 */
export function useAssistantShell({ activeView, setActiveView }: AppLocation) {
  const [interfaceMode, setInterfaceMode] = useState<InterfaceMode>(
    () => storedInterfaceMode() ?? "full",
  );
  const landed = useRef(isLandingPath(window.location.pathname));
  const view = useRef(activeView);
  view.current = activeView;

  useEffect(() => {
    let current = true;
    const leave = () => {
      if (!current || !landed.current || view.current !== "assistant") return;
      window.history.replaceState(
        window.history.state,
        "",
        `${pathForAppRoute({ view: "workspace" })}${window.location.search}${window.location.hash}`,
      );
      setActiveView("workspace");
    };
    getPersonalAgent().then(
      async (overview) => {
        const agent = overview.agent;
        if (!agent) return;
        if (!agent.settings.homePage) leave();
        const kept = storedInterfaceMode();
        if (kept === "simple" && !agent.settings.simpleInterface) {
          try {
            const saved = await updatePersonalAgentSettings({
              ...agent.settings,
              simpleInterface: true,
            });
            forgetStoredInterfaceMode();
            if (current) setInterfaceMode(modeOf(saved));
          } catch {
            // Kept for the next visit to carry over; it applies meanwhile.
          }
          return;
        }
        if (kept) forgetStoredInterfaceMode();
        if (current) setInterfaceMode(modeOf(agent));
      },
      (error) => {
        if (!isPersonalAgentUnavailable(error)) return;
        leave();
        if (current) setInterfaceMode("full");
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return { interfaceMode, setInterfaceMode };
}
