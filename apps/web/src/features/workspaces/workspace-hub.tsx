import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceProjection } from "@bd777/foundry-protocol";
import { FieldHint } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { PageHeader } from "../../components/ui/page-header";

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
    <PageSurface variant="workspace" className="w-full max-w-[1120px] gap-5.5">
      <PageHeader
        title={workspace.name || t("hub.fallbackName")}
        description={workspace.localPath || t("hub.noPath")}
      />
      {/* Every section reads or changes this workspace. Without one (still
          loading, or none chosen: the Workspaces page takes over) none
          mounts, so none asks for /api/workspaces//… */}
      {workspace.id ? (
        <>
          <SegmentedControl
            aria-label={t("hub.sectionsLabel")}
            className="max-[680px]:flex-wrap"
            value={section}
            onValueChange={onSectionChange}
            options={sections.map((value) => ({
              value,
              label: t(`hub.sections.${value}`),
            }))}
          />
          <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5"
            key={workspace.id}
          >
            {note ? (
              <FieldHint className="m-0 leading-[1.6]">{note}</FieldHint>
            ) : null}
            {children}
          </div>
        </>
      ) : null}
    </PageSurface>
  );
}
