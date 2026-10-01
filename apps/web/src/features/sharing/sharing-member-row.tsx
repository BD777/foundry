import { useTranslation } from "react-i18next";
import type { WorkspaceAccessRole } from "@bd777/foundry-protocol";
import type { WorkspaceMember } from "../../api-types";
import { Badge } from "../../components/ui/badge";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { SelectMenu } from "../../components/ui/select-menu";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import { roleOptions } from "./sharing-roles";

export function SharingMemberRow({
  member,
  self,
  manage,
  busy,
  onRoleChange,
  onRemove,
}: {
  member: WorkspaceMember;
  self: boolean;
  manage: boolean;
  busy: boolean;
  onRoleChange: (role: WorkspaceAccessRole) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("sharing");
  // The device owner always stays an Owner; everyone else may be changed by
  // an Owner, and anyone but the device owner may leave.
  const editable = manage && !member.deviceOwner;
  const removable = !member.deviceOwner && (manage || self);
  return (
    <li className="fdy-member-row" data-disabled={member.disabled || undefined}>
      <div className="fdy-member-identity">
        <strong>
          {self
            ? t("member.you", { name: member.displayName })
            : member.displayName}
        </strong>
        <span>{member.username}</span>
      </div>
      <div className="fdy-member-badges">
        {member.deviceOwner ? (
          <Badge tone="brass">{t("member.deviceOwner")}</Badge>
        ) : null}
        {member.disabled ? (
          <Badge tone="warn">{t("member.disabled")}</Badge>
        ) : null}
        {editable ? null : (
          <Badge tone="neutral">{workspaceRoleLabel(member.role)}</Badge>
        )}
      </div>
      <div className="fdy-member-actions">
        {editable ? (
          <SelectMenu
            ariaLabel={t("member.roleFor", { name: member.displayName })}
            disabled={busy}
            options={roleOptions()}
            value={member.role}
            onChange={(value) => {
              if (value !== member.role)
                onRoleChange(value as WorkspaceAccessRole);
            }}
          />
        ) : null}
        {removable ? (
          <ConfirmButton
            confirmLabel={
              self ? t("member.leaveConfirm") : t("member.removeConfirm")
            }
            disabled={busy}
            onConfirm={onRemove}
            size="sm"
          >
            {self ? t("member.leave") : t("member.remove")}
          </ConfirmButton>
        ) : null}
      </div>
    </li>
  );
}
