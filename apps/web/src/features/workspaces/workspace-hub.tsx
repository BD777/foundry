import type { ReactNode } from "react";
import type { WorkspaceProjection } from "@foundry/protocol";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";

export type WorkspaceSection =
  "workspace" | "settings" | "assets" | "skills" | "feishu" | "sharing";
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
  return (
    <PageSurface variant="workspace" className="fdy-workspace-hub">
      {selector}
      <header className="fdy-workspace-hub-heading">
        <h1>{workspace.name || "Workspace"}</h1>
        <p>
          {workspace.localPath || "Select or add a workspace to get started."}
        </p>
      </header>
      <SegmentedControl
        aria-label="Workspace settings sections"
        value={section}
        onValueChange={onSectionChange}
        options={[
          { value: "workspace", label: "Overview" },
          { value: "settings", label: "Agents & execution" },
          { value: "assets", label: "Assets" },
          { value: "skills", label: "Skills" },
          { value: "feishu", label: "Feishu Bot" },
          { value: "sharing", label: "Sharing" },
        ]}
      />
      <div className="fdy-workspace-hub-content" key={workspace.id}>
        {section === "settings" ? (
          <p className="fdy-workspace-scope-note">
            Agent profiles show their configuration scope. Worker capacity,
            runtime retention and device connections are shared by all
            workspaces on this device.
          </p>
        ) : null}
        {section === "assets" ? (
          <p className="fdy-workspace-scope-note">
            Assets available to this workspace. Device status and capacity are
            shared across workspaces.
          </p>
        ) : null}
        {section === "skills" ? (
          <p className="fdy-workspace-scope-note">
            Choose which server-published skills this workspace exposes to its
            Chats and Issues. Personal skills on a device stay unavailable
            unless promoted from the device's Skills tab.
          </p>
        ) : null}
        {section === "feishu" ? (
          <p className="fdy-workspace-scope-note">
            Connect a Feishu Bot and associate a group thread as an interactive
            agent channel for this workspace.
          </p>
        ) : null}
        {section === "sharing" ? (
          <p className="fdy-workspace-scope-note">
            Share this workspace with other Foundry accounts. Access covers this
            workspace only, never the rest of its device.
          </p>
        ) : null}
        {children}
      </div>
    </PageSurface>
  );
}
