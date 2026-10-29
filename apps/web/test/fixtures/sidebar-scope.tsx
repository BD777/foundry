/** Synthetic shell integration: real sidebar, location chooser and history hooks;
 * no real account, device, workspace or execution is mutated. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import { AppSidebar } from "../../src/app/app-sidebar";
import { AccountsGate } from "../../src/app/accounts-gate";
import { useShellPreferences } from "../../src/app/use-shell-preferences";
import {
  useAppLocation,
  useWorkspaceChoiceRedirect,
} from "../../src/app/use-app-location";
import { useAppRouteSync } from "../../src/app/use-app-route-sync";
import { useDocumentTitle } from "../../src/app/use-document-title";
import { workspaceFeatureEventHandler } from "../../src/app/workspace-feature-events";
import type { WorkspaceData } from "../../src/app/use-workspace-data";
import {
  FoundryShell,
  FoundryMain,
  FoundryView,
} from "../../src/components/ui/app-shell";
import { PageSurface } from "../../src/components/ui/page-surface";
import { WorkspacesFeature } from "../../src/features/workspaces";
import { fixtureDevice, fixtureWorkspace } from "../../src/app/fixtures";
import { emptyFoundryData } from "../../src/app/initial-data";
import { workspaceScopedViews } from "../../src/app/navigation";
const params = new URLSearchParams(location.search);
const lang = params.get("lang") ?? "en";
await i18n.changeLanguage(lang);
localStorage.setItem("foundry.themeMode", params.get("theme") ?? "light");
localStorage.setItem(
  "foundry.sidebarCollapsed",
  params.get("collapsed") ?? "false",
);
const user = {
  id: "synthetic",
  username: "scope-fixture",
  role: params.get("role") ?? "admin",
  locale: lang,
};
window.fetch = async (url) =>
  new Response(JSON.stringify(String(url).includes("/auth/") ? { user } : []), {
    headers: { "content-type": "application/json" },
  });
const devices =
  params.get("state") === "no-devices"
    ? []
    : [
        {
          ...fixtureDevice,
          id: "dev_fixture_a",
          label: params.get("long")
            ? "DevelopmentMachineWithAnUnbrokenVeryLongName — 共享开发设备"
            : "Studio Mac",
          status:
            params.get("state") === "removed"
              ? ("removed" as const)
              : params.get("state") === "offline"
                ? ("disconnected" as const)
                : ("connected" as const),
        },
        {
          ...fixtureDevice,
          id: "dev_fixture_b",
          label: "Build Linux",
          status: "connected" as const,
        },
      ];
const workspaces = devices.map((d, n) => ({
  ...fixtureWorkspace,
  id: `ws_fixture_${n}`,
  deviceId: d.id,
  name: n
    ? "Beta"
    : params.get("long")
      ? "WorkspaceWithAnUnbrokenVeryLongName — 多语言协作项目"
      : "Alpha",
  localPath: `/synthetic/${n}`,
}));
function Fixture() {
  const route = useAppLocation();
  const [activeWorkspaceId, setWorkspace] = useState(
    params.get("workspace") ??
      (params.get("state") === "empty" || !workspaces.length
        ? ""
        : (workspaces[0]?.id ?? "")),
  );
  const current = workspaces.find((w) => w.id === activeWorkspaceId);
  const data = {
    ...emptyFoundryData,
    devices,
    workspaces,
    workspace: current ?? emptyFoundryData.workspace,
  };
  const preferences = useShellPreferences();
  useWorkspaceChoiceRedirect(!current, route);
  useAppRouteSync({
    activeView: route.activeView,
    activeWorkspaceId,
    selectedChatId: route.selectedChatId,
    selectedIssueId: route.selectedIssueId,
    selectedDeviceId: route.selectedDeviceId,
    onPopState: (next, workspace) => {
      route.showRoute(next);
      setWorkspace(workspace);
    },
  });
  useDocumentTitle({
    view: route.activeView,
    workspaceName: current?.name ?? "",
  });
  const handler = workspaceFeatureEventHandler(route, {
    activeWorkspaceId,
    data,
    loadWorkspace: async (id: string) => {
      await new Promise((r) => setTimeout(r, 700));
      if (params.get("fail")) return false;
      setWorkspace(id);
      return true;
    },
    refreshData: async () => {},
  } as unknown as WorkspaceData);
  const label = i18n.t(`shell:views.${route.activeView}`);
  return (
    <FoundryShell theme={preferences.themeMode} scrollMode="page">
      <AppSidebar
        activeView={route.activeView}
        interfaceMode={params.get("simple") ? "simple" : "full"}
        counts={{ review: 2, running: 1, activeSkills: 3, pending: 0 }}
        onNavSelect={route.selectSidebarView}
        onNotice={() => {}}
        preferences={preferences}
        workspaceName={current?.name ?? ""}
        workspaceSelector={
          <WorkspacesFeature
            compact
            collapsed={preferences.sidebarCollapsed}
            activeWorkspaceId={activeWorkspaceId}
            devices={devices}
            workspaces={workspaces}
            onEvent={handler}
          />
        }
      />
      <FoundryMain>
        <FoundryView scrollMode="page">
          {route.activeView === "locations" ? (
            <WorkspacesFeature
              activeWorkspaceId={activeWorkspaceId}
              devices={devices}
              workspaces={workspaces}
              onEvent={handler}
            />
          ) : (
            <PageSurface variant="devices">
              <header className="fdy-management-heading">
                <div>
                  <h1>{label}</h1>
                  <p>
                    {workspaceScopedViews.has(route.activeView)
                      ? current?.name
                      : i18n.t("shell:sidebar.globalScope")}
                  </p>
                </div>
              </header>
            </PageSurface>
          )}
        </FoundryView>
      </FoundryMain>
    </FoundryShell>
  );
}
createRoot(document.getElementById("root")!).render(
  <AccountsGate>
    <Fixture />
  </AccountsGate>,
);
