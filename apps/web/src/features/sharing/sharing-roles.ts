import type { WorkspaceAccessRole } from "@bd777/foundry-protocol";
import type { SelectMenuOption } from "../../components/ui/select-menu";
import { i18n } from "../../i18n";
import { workspaceRoleLabel } from "../../lib/workspace-access";

const roles: WorkspaceAccessRole[] = [
  "viewer",
  "member",
  "maintainer",
  "owner",
];

export function roleOptions(): SelectMenuOption[] {
  return roles.map((value) => ({
    value,
    label: workspaceRoleLabel(value),
    detail: i18n.t(`sharing:roleDetails.${value}`),
  }));
}

/** Roles that start agents, which run commands on the device. */
export function runsCode(role: WorkspaceAccessRole): boolean {
  return role !== "viewer";
}
