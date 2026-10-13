import type { WorkspaceAccessRole } from "@bd777/foundry-protocol";
import type {
  AccountInvite,
  AccountRole,
  AccountUser,
  AuthState,
  CreatedAccountInvite,
  InvitePreview,
  NewAccountInput,
  WorkspaceMember,
} from "../api-types";
import { foundryStream } from "../stream/foundry-stream";
import { request, sharedReads, type RequestInput } from "./http";

/**
 * Account calls answer 401 for a wrong password, which is not a lost session,
 * so they do not notify auth-required listeners.
 */
function accountRequest<T>(
  method: string,
  path: string,
  body?: RequestInput["body"],
): Promise<T> {
  return request(method, path, { body, notifyAuthRequired: false });
}

export function getAuthState(): Promise<AuthState> {
  return accountRequest("GET", "/api/auth/state");
}

export function setupFirstOwner(
  input: NewAccountInput & { setupCode: string },
): Promise<AuthState> {
  return accountRequest("POST", "/api/auth/setup", input);
}

export function login(username: string, password: string): Promise<AuthState> {
  return accountRequest("POST", "/api/auth/login", { username, password });
}

export async function logout(): Promise<void> {
  await accountRequest("POST", "/api/auth/logout");
  sharedReads.forget();
  foundryStream.announceSignedOut();
}

export function updateMyDisplayName(displayName: string): Promise<AccountUser> {
  return accountRequest("PATCH", "/api/auth/me", { displayName });
}

export function updateMyLocale(
  locale: "" | "en" | "zh-CN",
): Promise<AccountUser> {
  return accountRequest("PATCH", "/api/auth/me", { locale });
}

export function changeMyPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return accountRequest("POST", "/api/auth/me/password", {
    currentPassword,
    newPassword,
  });
}

export function getInvite(token: string): Promise<InvitePreview> {
  return accountRequest(
    "GET",
    `/api/auth/invites/${encodeURIComponent(token)}`,
  );
}

export function acceptInvite(
  token: string,
  input: NewAccountInput,
): Promise<AuthState> {
  return accountRequest(
    "POST",
    `/api/auth/invites/${encodeURIComponent(token)}/accept`,
    input,
  );
}

export function listUsers(): Promise<AccountUser[]> {
  return accountRequest("GET", "/api/users");
}

export function updateUser(
  id: string,
  update: { role?: AccountRole; disabled?: boolean },
): Promise<AccountUser> {
  return accountRequest(
    "PATCH",
    `/api/users/${encodeURIComponent(id)}`,
    update,
  );
}

export function listInvites(): Promise<AccountInvite[]> {
  return accountRequest("GET", "/api/invites");
}

export function createInvite(
  role: AccountRole,
  workspace?: { workspaceId: string; workspaceRole: WorkspaceAccessRole },
): Promise<CreatedAccountInvite> {
  return accountRequest("POST", "/api/invites", { role, ...workspace });
}

export function revokeInvite(id: string): Promise<void> {
  return accountRequest("DELETE", `/api/invites/${encodeURIComponent(id)}`);
}

// --- Workspace sharing ---

function membersPath(workspaceId: string, userId?: string): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;
  return userId ? `${base}/${encodeURIComponent(userId)}` : base;
}

export function listWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return accountRequest("GET", membersPath(workspaceId));
}

export function addWorkspaceMember(
  workspaceId: string,
  username: string,
  role: WorkspaceAccessRole,
): Promise<void> {
  return accountRequest("POST", membersPath(workspaceId), { username, role });
}

export function updateWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceAccessRole,
): Promise<void> {
  return accountRequest("PATCH", membersPath(workspaceId, userId), { role });
}

export function removeWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  return accountRequest("DELETE", membersPath(workspaceId, userId));
}
