import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceAccessRole,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  addWorkspaceMember,
  createInvite,
  listWorkspaceMembers,
  removeWorkspaceMember,
  subscribeFoundryEvents,
  updateWorkspaceMember,
} from "../../api";
import type { WorkspaceMember } from "../../api-types";
import { i18n } from "../../i18n";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { SelectMenu } from "../../components/ui/select-menu";
import { inviteLink } from "../../lib/invite-link";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import { SharingMemberRow } from "./sharing-member-row";
import { roleOptions, runsCode } from "./sharing-roles";
import "./sharing.css";

export interface SharingFeatureProps {
  workspace: WorkspaceProjection;
  deviceLabel?: string;
  currentUserId: string;
  /** Instance admins may also invite people who have no account yet. */
  canInvite: boolean;
  /** The caller left the workspace; the app should move elsewhere. */
  onLeft: () => void;
}

export function SharingFeature({
  workspace,
  deviceLabel,
  currentUserId,
  canInvite,
  onLeft,
}: SharingFeatureProps) {
  const { t } = useTranslation("sharing");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<WorkspaceAccessRole>("viewer");
  const [invite, setInvite] = useState("");
  const manage = workspace.accessRole === "owner";
  const device = deviceLabel ?? t("thisDevice");
  const owner = members.find((member) => member.deviceOwner);

  const reload = useCallback(async () => {
    setMembers(await listWorkspaceMembers(workspace.id));
  }, [workspace.id]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      reload().catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason));
      });
    void refresh();
    const unsubscribe = subscribeFoundryEvents((event) => {
      if (
        event.type === "workspace_members_updated" &&
        event.payload.workspaceId === workspace.id
      )
        void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reload, workspace.id]);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await action();
      await reload();
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setBusy("");
    }
  }

  async function add() {
    const name = username.trim();
    if (!name) return;
    const added = await run("add", () =>
      addWorkspaceMember(workspace.id, name, role),
    );
    if (added) setUsername("");
  }

  async function leave(member: WorkspaceMember) {
    setBusy(member.userId);
    setError("");
    try {
      await removeWorkspaceMember(workspace.id, member.userId);
      onLeft();
    } catch (reason) {
      setError(messageOf(reason));
      setBusy("");
    }
  }

  return (
    <div className="fdy-sharing">
      {error ? (
        <Alert tone="error" title={t("updateFailed")}>
          {error}
        </Alert>
      ) : null}
      {manage ? (
        <Panel className="fdy-account-section">
          <div className="fdy-account-section-head">
            <strong>{t("add.title")}</strong>
            <p>{t("add.body")}</p>
          </div>
          <div className="fdy-member-invite-row">
            <TextInput
              aria-label={t("add.username")}
              className="fdy-sharing-username"
              placeholder={t("add.usernamePlaceholder")}
              tone="boxed"
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
              }}
            />
            <SelectMenu
              ariaLabel={t("add.role")}
              options={roleOptions()}
              value={role}
              onChange={(value) => setRole(value as WorkspaceAccessRole)}
            />
            <Button
              variant="primary"
              disabled={busy === "add" || !username.trim()}
              onClick={() => void add()}
            >
              {busy === "add" ? t("add.submitting") : t("add.submit")}
            </Button>
            {canInvite ? (
              <Button
                disabled={busy === "invite"}
                onClick={() =>
                  void run("invite", async () => {
                    const created = await createInvite("member", {
                      workspaceId: workspace.id,
                      workspaceRole: role,
                    });
                    setInvite(inviteLink(created.token));
                  })
                }
              >
                {t("add.invite")}
              </Button>
            ) : null}
          </div>
          {runsCode(role) ? (
            <Alert tone="warning" title={t("runsCode.title")}>
              {t("runsCode.body", {
                role: workspaceRoleLabel(role),
                device,
                owner: owner?.displayName ?? t("itsOwner"),
              })}
            </Alert>
          ) : null}
          {invite ? (
            <div className="fdy-member-invite-link">
              <span>
                {t("inviteLink.body", { role: workspaceRoleLabel(role) })}
              </span>
              <div className="fdy-member-invite-copy">
                <TextInput
                  aria-label={t("inviteLink.label")}
                  readOnly
                  tone="boxed"
                  value={invite}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  onClick={() => void navigator.clipboard?.writeText(invite)}
                >
                  {t("inviteLink.copy")}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}
      <Panel className="fdy-account-section">
        <div className="fdy-account-section-head">
          <strong>{t("people.title")}</strong>
          <p>{manage ? t("people.manageHint") : t("people.readOnlyHint")}</p>
        </div>
        <ul className="fdy-member-list">
          {members.map((member) => (
            <SharingMemberRow
              key={member.userId}
              member={member}
              self={member.userId === currentUserId}
              manage={manage}
              busy={busy === member.userId}
              onRoleChange={(next) =>
                void run(member.userId, () =>
                  updateWorkspaceMember(workspace.id, member.userId, next),
                )
              }
              onRemove={() =>
                member.userId === currentUserId
                  ? void leave(member)
                  : void run(member.userId, () =>
                      removeWorkspaceMember(workspace.id, member.userId),
                    )
              }
            />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : i18n.t("common:errors.serverUnreachable");
}
