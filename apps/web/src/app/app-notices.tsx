import { useCallback, useEffect } from "react";
import { toast, type ToastTone } from "../components/ui/toast";
import { useTranslation } from "react-i18next";
import { NoticeLine, NoticeStack } from "../components/ui/app-shell";
import { NewBuildNotice } from "./deployed-build";
import type { ApiState } from "./use-workspace-data";

/** Transient outcomes share the app's floating Toast viewport. */
export function useTransientNotice() {
  const notify = useCallback((message: string, tone?: ToastTone) => {
    if (message) toast({ title: message, tone });
  }, []);
  return ["", notify] as const;
}

export interface AppNoticesProps {
  apiState: ApiState;
  demoFallback: boolean;
  notice: string;
}

/** The status line: connection state, the current notice, a newer build. */
export function AppNotices({ apiState, demoFallback }: AppNoticesProps) {
  const { t } = useTranslation(["shell", "common"]);
  useEffect(() => {
    if (apiState !== "saving" && apiState !== "loading") return;
    const id = toast({
      id: "shell-progress",
      title: t(
        apiState === "saving"
          ? "common:states.saving"
          : "common:states.loading",
      ),
      duration: Infinity,
    });
    return () => toast.dismiss(id);
  }, [apiState, t]);
  return (
    <NoticeStack>
      {apiState === "fallback" ? (
        <NoticeLine>
          {demoFallback
            ? t("notices.demoFallback")
            : t("notices.apiUnreachable")}
        </NoticeLine>
      ) : null}
      <NewBuildNotice />
    </NoticeStack>
  );
}
