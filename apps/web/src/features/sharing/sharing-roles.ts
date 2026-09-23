import type { WorkspaceAccessRole } from "@foundry/protocol";
import type { SelectMenuOption } from "../../components/ui/select-menu";

export const roleOptions: SelectMenuOption[] = [
  {
    value: "viewer",
    label: "Viewer",
    detail: "Reads Issues, Chats, evidence and files",
  },
  {
    value: "member",
    label: "Member",
    detail: "Also chats, creates and runs its own Issues",
  },
  {
    value: "maintainer",
    label: "Maintainer",
    detail: "Also accepts work and manages skills and Feishu",
  },
  {
    value: "owner",
    label: "Owner",
    detail: "Also manages people, renames and removes",
  },
];

/** Roles that start agents, which run commands on the device. */
export function runsCode(role: WorkspaceAccessRole): boolean {
  return role !== "viewer";
}
