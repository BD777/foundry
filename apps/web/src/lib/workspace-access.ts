import type {
  WorkspaceAccessRole,
  WorkspaceProjection,
} from "@foundry/protocol";

const roleRank: Record<WorkspaceAccessRole, number> = {
  viewer: 1,
  member: 2,
  maintainer: 3,
  owner: 4,
};

const roleLabel: Record<WorkspaceAccessRole, string> = {
  viewer: "Viewer",
  member: "Member",
  maintainer: "Maintainer",
  owner: "Owner",
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
  return `You are a ${roleLabel[have]} in this workspace; this needs ${roleLabel[need]} or higher.`;
}

export function workspaceRoleLabel(role: WorkspaceAccessRole): string {
  return roleLabel[role];
}
