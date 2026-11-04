import { toast } from "../../components/ui/toast";
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
import { DividedList } from "../../components/ui/divided-list";
import { Identity } from "../../components/ui/identity";
import { MemberChips, MemberRow } from "../../components/ui/member-row";
import { SectionPanel } from "../../components/ui/section-panel";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  inviteLink,
  invitePending,
  roleLabel,
  roleNoun,
} from "./account-format";
import { serverErrorText } from "../../lib/errors";
import { dateOnly } from "../../lib/time-format";
import { useCopied } from "../../lib/use-copied";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import { useTranslation } from "react-i18next";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";

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
  const { copied, copy, reset: resetCopied } = useCopied();

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
        if (!cancelled) setError(serverErrorText(reason));
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
      toast({
        tone: "error",
        title: t("members.updateFailed"),
        description: serverErrorText(reason),
      });
    } finally {
      setBusyId("");
    }
  }

  const pendingInvites = invites.filter((invite) => invitePending(invite));
  const createdLink = created ? inviteLink(created.token) : "";

  return (
    <PageSurface variant="members">
      <PageHeader title={t("members.title")} description={t("members.intro")} />

      {error ? (
        <Alert tone="error" title={t("members.loadFailed")}>
          {error}
        </Alert>
      ) : null}

      <SectionPanel spacing="roomy">
        <SectionHeader
          level={3}
          description={t("members.inviteHint")}
          title={t("members.inviteTitle")}
        />
        <div className="flex flex-wrap items-center gap-3">
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
                resetCopied();
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
          <div className="grid gap-1.5">
            <span className="text-xs font-semibold text-warning-text">
              {t("members.createdInvite", { role: roleLabel(created.role) })}
            </span>
            <div className="flex min-w-0 gap-2 [&>input]:min-w-0 [&>input]:flex-1">
              <TextInput
                aria-label={t("members.inviteLink")}
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                tone="boxed"
                value={createdLink}
              />
              <Button onClick={() => void copy(createdLink)}>
                {copied() ? t("common:actions.copied") : t("members.copyLink")}
              </Button>
            </div>
          </div>
        ) : null}
        {pendingInvites.length > 0 ? (
          <DividedList>
            {pendingInvites.map((invite) => (
              <MemberRow key={invite.id}>
                <Identity lines="truncate">
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
                      date: dateOnly(invite.expiresAt),
                    })}
                  </span>
                </Identity>
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
              </MemberRow>
            ))}
          </DividedList>
        ) : null}
      </SectionPanel>

      <SectionPanel spacing="roomy">
        <SectionHeader level={3} title={t("members.people")} />
        {loaded && users.length === 0 ? (
          <EmptyState
            title={t("members.noMembers")}
            body={t("members.noMembersBody")}
          />
        ) : (
          <DividedList>
            {users.map((user) => {
              const self = user.id === currentUserId;
              const disabled = Boolean(user.disabledAt);
              const nextRole: AccountRole =
                user.role === "admin" ? "member" : "admin";
              return (
                <MemberRow data-disabled={disabled || undefined} key={user.id}>
                  <Identity lines="truncate">
                    <strong>
                      {self
                        ? t("members.you", { name: user.displayName })
                        : user.displayName}
                    </strong>
                    <span>
                      {t("members.joined", {
                        username: user.username,
                        date: dateOnly(user.createdAt),
                      })}
                    </span>
                  </Identity>
                  <MemberChips>
                    <Badge tone={user.role === "admin" ? "brass" : "neutral"}>
                      {roleLabel(user.role)}
                    </Badge>
                    {disabled ? (
                      <Badge tone="warn">{t("members.disabled")}</Badge>
                    ) : null}
                  </MemberChips>
                  <MemberChips>
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
                  </MemberChips>
                </MemberRow>
              );
            })}
          </DividedList>
        )}
      </SectionPanel>
    </PageSurface>
  );
}
