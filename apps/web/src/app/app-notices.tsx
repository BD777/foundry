import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NoticeLine, NoticeStack } from "../components/ui/app-shell";
import { NewBuildNotice } from "./deployed-build";
import type { ApiState } from "./use-workspace-data";

/** A notice for the status line that dismisses itself after a while. */
export function useTransientNotice() {
  const [notice, setNotice] = useState("");
  // Auto-dismiss transient notices so the status line does not go stale.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice] as const;
}

export interface AppNoticesProps {
  apiState: ApiState;
  demoFallback: boolean;
  notice: string;
}

/** The status line: connection state, the current notice, a newer build. */
export function AppNotices({
  apiState,
  demoFallback,
  notice,
}: AppNoticesProps) {
  const { t } = useTranslation(["shell", "common"]);
  return (
    <NoticeStack>
      {apiState === "fallback" ? (
        <NoticeLine>
          {demoFallback
            ? t("notices.demoFallback")
            : t("notices.apiUnreachable")}
        </NoticeLine>
      ) : null}
      {apiState === "saving" ? (
        <NoticeLine>{t("common:states.saving")}</NoticeLine>
      ) : null}
      {apiState === "loading" ? (
        <NoticeLine>{t("common:states.loading")}</NoticeLine>
      ) : null}
      {notice ? <NoticeLine>{notice}</NoticeLine> : null}
      <NewBuildNotice />
    </NoticeStack>
  );
}
