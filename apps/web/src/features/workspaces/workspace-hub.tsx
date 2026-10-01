import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceProjection } from "@bd777/foundry-protocol";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";

export type WorkspaceSection =
  "workspace" | "settings" | "assets" | "skills" | "feishu" | "sharing";
const sections: WorkspaceSection[] = [
  "workspace",
  "settings",
  "assets",
  "skills",
  "feishu",
  "sharing",
];

export function WorkspaceHub({
  workspace,
  section,
  onSectionChange,
  selector,
  children,
}: {
  workspace: WorkspaceProjection;
  section: WorkspaceSection;
  onSectionChange: (section: WorkspaceSection) => void;
  selector: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation("workspaces");
  const note = section === "workspace" ? undefined : t(`hub.notes.${section}`);
  return (
    <PageSurface variant="workspace" className="fdy-workspace-hub">
      {selector}
      <header className="fdy-workspace-hub-heading">
        <h1>{workspace.name || t("hub.fallbackName")}</h1>
        <p>{workspace.localPath || t("hub.noPath")}</p>
      </header>
      <SegmentedControl
        aria-label={t("hub.sectionsLabel")}
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
    </PageSurface>
  );
}
