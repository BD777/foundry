import { useEffect } from "react";
import type { DeviceProjection, Issue } from "@bd777/foundry-protocol";
import { i18n } from "../i18n";
import { appName, setDocumentPage } from "../lib/document-title";
import type { NavView } from "./navigation";

const globalViews = new Set<NavView>([
  "account",
  "members",
  "profiles",
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
  useEffect(() => {
    setDocumentPage({ primary, context });
  }, [primary, context]);
  useEffect(
    () => () => {
      document.title = appName;
    },
    [],
  );
}
