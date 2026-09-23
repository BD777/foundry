import type { AccountInvite, AccountRole } from "../../api-types";

export function roleLabel(role: AccountRole): string {
  return role === "admin" ? "Admin" : "Member";
}

export function formatAccountDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function invitePending(
  invite: AccountInvite,
  now = Date.now(),
): boolean {
  return (
    !invite.usedAt &&
    !invite.revokedAt &&
    new Date(invite.expiresAt).getTime() > now
  );
}

export { inviteLink } from "../../lib/invite-link";
