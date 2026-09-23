import { useCallback, useEffect, useState } from "react";
import {
  createInvite,
  listInvites,
  listUsers,
  revokeInvite,
  updateUser,
} from "../../api";
import type {
  AccountInvite,
  AccountRole,
  AccountUser,
  CreatedAccountInvite,
} from "../../api-types";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { EmptyState } from "../../components/ui/empty-state";
import { TextInput } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { Panel } from "../../components/ui/panel";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  formatAccountDate,
  inviteLink,
  invitePending,
  roleLabel,
} from "./account-format";
import { workspaceRoleLabel } from "../../lib/workspace-access";

export interface MembersFeatureProps {
  currentUserId: string;
}

const roleOptions: Array<{ label: string; value: AccountRole }> = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

export function MembersFeature({ currentUserId }: MembersFeatureProps) {
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [invites, setInvites] = useState<AccountInvite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [inviteRole, setInviteRole] = useState<AccountRole>("member");
  const [created, setCreated] = useState<CreatedAccountInvite | undefined>();
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    const [nextUsers, nextInvites] = await Promise.all([
      listUsers(),
      listInvites(),
    ]);
    setUsers(nextUsers);
    setInvites(nextInvites);
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload()
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function run(
    id: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setBusyId(id);
    setError("");
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId("");
    }
  }

  async function copyLink(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const pendingInvites = invites.filter((invite) => invitePending(invite));
  const createdLink = created ? inviteLink(created.token) : "";

  return (
    <PageSurface variant="accounts">
      <div className="fdy-account-intro">
        <strong>Members</strong>
        <p>
          People who can sign in to this Foundry server. Admins manage members,
          devices, connections and Accept; members chat, create and run Issues.
        </p>
      </div>

      {error ? (
        <Alert tone="error" title="Members could not be updated">
          {error}
        </Alert>
      ) : null}

      <Panel className="fdy-account-section">
        <div className="fdy-account-section-head">
          <strong>Invite someone</strong>
          <p>Invite links work once and expire after 7 days.</p>
        </div>
        <div className="fdy-member-invite-row">
          <SegmentedControl
            aria-label="Role for the new member"
            onValueChange={setInviteRole}
            options={roleOptions}
            value={inviteRole}
          />
          <Button
            disabled={busyId === "invite"}
            onClick={() =>
              void run("invite", async () => {
                setCopied(false);
                setCreated(await createInvite(inviteRole));
              })
            }
            variant="primary"
          >
            {busyId === "invite" ? "Creating…" : "Create invite link"}
          </Button>
        </div>
        {created ? (
          <div className="fdy-member-invite-link">
            <span>
              {roleLabel(created.role)} invite · copy it now, it is shown only
              once
            </span>
            <div className="fdy-member-invite-copy">
              <TextInput
                aria-label="Invite link"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                tone="boxed"
                value={createdLink}
              />
              <Button onClick={() => void copyLink(createdLink)}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        ) : null}
        {pendingInvites.length > 0 ? (
          <ul className="fdy-member-list">
            {pendingInvites.map((invite) => (
              <li className="fdy-member-row" key={invite.id}>
                <div className="fdy-member-identity">
                  <strong>
                    Pending {roleLabel(invite.role).toLowerCase()} invite
                  </strong>
                  <span>
                    {invite.workspaceRole
                      ? `Joins a workspace as ${workspaceRoleLabel(invite.workspaceRole)} · `
                      : ""}
                    Expires {formatAccountDate(invite.expiresAt)}
                  </span>
                </div>
                <ConfirmButton
                  confirmLabel="Revoke for good?"
                  disabled={busyId === invite.id}
                  onConfirm={() =>
                    void run(invite.id, () => revokeInvite(invite.id))
                  }
                  size="sm"
                >
                  Revoke
                </ConfirmButton>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel className="fdy-account-section">
        <div className="fdy-account-section-head">
          <strong>People</strong>
        </div>
        {loaded && users.length === 0 ? (
          <EmptyState
            title="No members yet"
            body="Create an invite link above."
          />
        ) : (
          <ul className="fdy-member-list">
            {users.map((user) => {
              const self = user.id === currentUserId;
              const disabled = Boolean(user.disabledAt);
              const nextRole: AccountRole =
                user.role === "admin" ? "member" : "admin";
              return (
                <li
                  className="fdy-member-row"
                  data-disabled={disabled || undefined}
                  key={user.id}
                >
                  <div className="fdy-member-identity">
                    <strong>
                      {user.displayName}
                      {self ? " (you)" : ""}
                    </strong>
                    <span>
                      {user.username} · joined{" "}
                      {formatAccountDate(user.createdAt)}
                    </span>
                  </div>
                  <div className="fdy-member-badges">
                    <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
                      {roleLabel(user.role)}
                    </Badge>
                    {disabled ? <Badge tone="warn">Disabled</Badge> : null}
                  </div>
                  <div className="fdy-member-actions">
                    {self ? null : (
                      <Button
                        disabled={busyId === user.id || disabled}
                        onClick={() =>
                          void run(user.id, () =>
                            updateUser(user.id, { role: nextRole }),
                          )
                        }
                        size="sm"
                      >
                        Make {roleLabel(nextRole).toLowerCase()}
                      </Button>
                    )}
                    {self ? null : disabled ? (
                      <Button
                        disabled={busyId === user.id}
                        onClick={() =>
                          void run(user.id, () =>
                            updateUser(user.id, { disabled: false }),
                          )
                        }
                        size="sm"
                      >
                        Enable
                      </Button>
                    ) : (
                      <ConfirmButton
                        confirmLabel="Disable and sign out?"
                        disabled={busyId === user.id}
                        onConfirm={() =>
                          void run(user.id, () =>
                            updateUser(user.id, { disabled: true }),
                          )
                        }
                        size="sm"
                      >
                        Disable
                      </ConfirmButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </PageSurface>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : "The Foundry server did not answer. Try again.";
}
