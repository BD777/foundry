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
  roleNoun,
} from "./account-format";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";

export interface MembersFeatureProps {
  currentUserId: string;
}

const inviteRoles: AccountRole[] = ["member", "admin"];

export function MembersFeature({ currentUserId }: MembersFeatureProps) {
  const { t } = useTranslation(["account", "common"]);
  const roleOptions = inviteRoles.map((value) => ({
    label: roleLabel(value),
    value,
  }));
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
        <strong>{t("members.title")}</strong>
        <p>{t("members.intro")}</p>
      </div>

      {error ? (
        <Alert tone="error" title={t("members.updateFailed")}>
          {error}
        </Alert>
      ) : null}

      <Panel className="fdy-account-section">
        <div className="fdy-account-section-head">
          <strong>{t("members.inviteTitle")}</strong>
          <p>{t("members.inviteHint")}</p>
        </div>
        <div className="fdy-member-invite-row">
          <SegmentedControl
            aria-label={t("members.inviteRole")}
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
            {busyId === "invite"
              ? t("members.creatingInvite")
              : t("members.createInvite")}
          </Button>
        </div>
        {created ? (
          <div className="fdy-member-invite-link">
            <span>
              {t("members.createdInvite", { role: roleLabel(created.role) })}
            </span>
            <div className="fdy-member-invite-copy">
              <TextInput
                aria-label={t("members.inviteLink")}
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                tone="boxed"
                value={createdLink}
              />
              <Button onClick={() => void copyLink(createdLink)}>
                {copied ? t("common:actions.copied") : t("members.copyLink")}
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
                    {t("members.pendingInvite", {
                      role: roleNoun(invite.role),
                    })}
                  </strong>
                  <span>
                    {invite.workspaceRole
                      ? t("members.joinsWorkspaceAs", {
                          role: workspaceRoleLabel(invite.workspaceRole),
                        })
                      : ""}
                    {t("members.expires", {
                      date: formatAccountDate(invite.expiresAt),
                    })}
                  </span>
                </div>
                <ConfirmButton
                  confirmLabel={t("members.revokeConfirm")}
                  disabled={busyId === invite.id}
                  onConfirm={() =>
                    void run(invite.id, () => revokeInvite(invite.id))
                  }
                  size="sm"
                >
                  {t("members.revoke")}
                </ConfirmButton>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel className="fdy-account-section">
        <div className="fdy-account-section-head">
          <strong>{t("members.people")}</strong>
        </div>
        {loaded && users.length === 0 ? (
          <EmptyState
            title={t("members.noMembers")}
            body={t("members.noMembersBody")}
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
                      {self
                        ? t("members.you", { name: user.displayName })
                        : user.displayName}
                    </strong>
                    <span>
                      {t("members.joined", {
                        username: user.username,
                        date: formatAccountDate(user.createdAt),
                      })}
                    </span>
                  </div>
                  <div className="fdy-member-badges">
                    <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
                      {roleLabel(user.role)}
                    </Badge>
                    {disabled ? (
                      <Badge tone="warn">{t("members.disabled")}</Badge>
                    ) : null}
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
                        {t("members.makeRole", { role: roleNoun(nextRole) })}
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
                        {t("members.enable")}
                      </Button>
                    ) : (
                      <ConfirmButton
                        confirmLabel={t("members.disableConfirm")}
                        disabled={busyId === user.id}
                        onConfirm={() =>
                          void run(user.id, () =>
                            updateUser(user.id, { disabled: true }),
                          )
                        }
                        size="sm"
                      >
                        {t("members.disable")}
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
    : i18n.t("common:errors.serverUnreachable");
}
