import type { ToastTone } from "../components/ui/toast";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IssueDraftRequest } from "../features/issues";
import type { WorkerRuntimeId } from "@bd777/foundry-protocol";
import type { NavView } from "./navigation";

/**
 * A request, from any page, to draft an Issue from some source text: it
 * opens the Issues composer with the source loaded.
 */
export function useIssueDraftRequest(
  setActiveView: (view: NavView) => void,
  setNotice: (message: string, tone?: ToastTone) => void,
) {
  const { t } = useTranslation("shell");
  const [request, setRequest] = useState<IssueDraftRequest>();
  const requestIdRef = useRef(0);

  const draftFromSource = useCallback(
    (source: string, runtime?: WorkerRuntimeId): void => {
      requestIdRef.current += 1;
      setRequest({ id: requestIdRef.current, runtime, source });
      setActiveView("issues");
      setNotice(t("notices.draftLoaded"));
    },
    [],
  );

  return { request, draftFromSource };
}
