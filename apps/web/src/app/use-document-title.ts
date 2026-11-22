import { useEffect } from "react";
import type { DeviceProjection, Issue } from "@bd777/foundry-protocol";
import { i18n } from "../i18n";
import { appName, setDocumentPage } from "../lib/document-title";
import type { NavView } from "../lib/routes";

const globalViews = new Set<NavView>([
  "assistant",
  "items",
  "assistants",
  "assistantSettings",
  "pending",
  "account",
  "members",
  "profiles",
  "connectors",
  "usage",
  "resources",
  "library",
  "locations",
  "devices",
]);

/** The tab title's page part, from what the app shell shows. */
export function documentPageTitle(input: {
  view: NavView;
  workspaceName: string;
  issue?: Pick<Issue, "shortId" | "title">;
  device?: Pick<DeviceProjection, "label">;
  /** The assistant's home conversation holds an unseen answer (DEV-278). */
  assistantUnread?: boolean;
  /** Open requests that need the person (the sidebar's 等你处理 count). */
  needsYouCount?: number;
}): { primary: string; context?: string } {
  const page = i18n.t(
    input.view === "workspace"
      ? "shell:nav.overview"
      : `shell:views.${input.view}`,
  );
  if (input.view === "devices" && input.device)
    return { primary: input.device.label, context: page };
  if (globalViews.has(input.view)) return { primary: page };
  if (input.view === "issue" && input.issue)
    return {
      primary: `${input.issue.shortId} ${input.issue.title}`,
      context: input.workspaceName,
    };
  return { primary: page, context: input.workspaceName };
}

export function useDocumentTitle(
  input: Parameters<typeof documentPageTitle>[0],
) {
  const { primary, context } = documentPageTitle(input);
  const assistantUnread = input.assistantUnread ?? false;
  const needsYouCount = input.needsYouCount ?? 0;
  useEffect(() => {
    setDocumentPage({ primary, context, assistantUnread, needsYouCount });
  }, [primary, context, assistantUnread, needsYouCount]);
  useEffect(
    () => () => {
      document.title = appName;
    },
    [],
  );
}
