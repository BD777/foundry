import type { AccountInvite, AccountRole } from "../../api-types";
import { i18n } from "../../i18n";

export function roleLabel(role: AccountRole): string {
  return i18n.t(`common:roles.${role}`);
}

/** The role inside a sentence: "invited as member". */
export function roleNoun(role: AccountRole): string {
  return i18n.t(`common:roleNouns.${role}`);
}

export function formatAccountDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(i18n.language, {
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
