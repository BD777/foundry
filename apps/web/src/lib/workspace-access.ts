import type {
  WorkspaceAccessRole,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

const roleRank: Record<WorkspaceAccessRole, number> = {
  viewer: 1,
  member: 2,
  maintainer: 3,
  owner: 4,
};

/**
 * Why the caller cannot perform an action needing `need` in the workspace, or
 * undefined when it can. A workspace without a role (the empty placeholder
 * before any daemon registers) is left to the server to decide.
 */
export function workspaceDenial(
  workspace: Pick<WorkspaceProjection, "accessRole"> | undefined,
  need: WorkspaceAccessRole,
): string | undefined {
  const have = workspace?.accessRole;
  if (!have || roleRank[have] >= roleRank[need]) return undefined;
  return i18n.t("common:access.denied", {
    have: workspaceRoleLabel(have),
    need: workspaceRoleLabel(need),
  });
}

export function workspaceRoleLabel(role: WorkspaceAccessRole): string {
  return i18n.t(`common:roles.${role}`);
}
