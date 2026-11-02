import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceProjection } from "@bd777/foundry-protocol";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";

export type WorkspaceSection =
  | "workspace"
  | "settings"
  | "assets"
  | "skills"
  | "channels"
  | "workspaceConnectors"
  | "sharing";
const sections: WorkspaceSection[] = [
  "workspace",
  "settings",
  "assets",
  "skills",
  "channels",
  "workspaceConnectors",
  "sharing",
];

export function WorkspaceHub({
  workspace,
  section,
  onSectionChange,
  children,
}: {
  workspace: WorkspaceProjection;
  section: WorkspaceSection;
  onSectionChange: (section: WorkspaceSection) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("workspaces");
  const note = section === "workspace" ? undefined : t(`hub.notes.${section}`);
  return (
    <PageSurface variant="workspace" className="fdy-workspace-hub">
      <header className="fdy-workspace-hub-heading">
        <h1>{workspace.name || t("hub.fallbackName")}</h1>
        <p>{workspace.localPath || t("hub.noPath")}</p>
      </header>
      {/* Every section reads or changes this workspace. Without one (still
          loading, or none chosen: the Workspaces page takes over) none
          mounts, so none asks for /api/workspaces//… */}
      {workspace.id ? (
        <>
          <SegmentedControl
            aria-label={t("hub.sectionsLabel")}
            className="fdy-workspace-hub-tabs"
            value={section}
            onValueChange={onSectionChange}
            options={sections.map((value) => ({
              value,
              label: t(`hub.sections.${value}`),
            }))}
          />
          <div className="fdy-workspace-hub-content" key={workspace.id}>
            {note ? <p className="fdy-workspace-scope-note">{note}</p> : null}
            {children}
          </div>
        </>
      ) : null}
    </PageSurface>
  );
}
