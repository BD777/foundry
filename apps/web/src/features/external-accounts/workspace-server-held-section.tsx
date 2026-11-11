import type {
  ConnectorDescriptor,
  ExternalAccount,
} from "@bd777/foundry-protocol";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CheckLabel } from "../../components/ui/check-label";
import { DividedList } from "../../components/ui/divided-list";
import { Checkbox } from "../../components/ui/field";
import { Identity } from "../../components/ui/identity";
import { MutedText } from "../../components/ui/text";
import { organisationLabel } from "../../lib/feishu-app-names";
import {
  accountUsable,
  customLabel,
  personName,
  providerLabel,
  statusLabel,
  statusTone,
} from "./account-format";
import { connectorDescription, connectorName } from "./connector-text";
import { ConnectorSection } from "./connector-section";
import { CredentialHolding } from "./credential-holding";

export interface WorkspaceServerHeldSectionProps {
  kind: string;
  descriptor?: ConnectorDescriptor;
  mine: ExternalAccount[];
  theirs: ExternalAccount[];
  bound: Set<string>;
  busy: boolean;
  readOnlyReason?: string;
  authorizing: boolean;
  onConnect: (account?: ExternalAccount) => void;
  onManage: () => void;
  onToggle: (account: ExternalAccount, use: boolean) => void;
}

/**
 * One server-held connector on a workspace page. Feishu keeps its
 * sign-in action; extension instances are managed on the Connectors page and
 * appear here only for binding.
 */
export function WorkspaceServerHeldSection({
  kind,
  descriptor,
  mine,
  theirs,
  bound,
  busy,
  readOnlyReason,
  authorizing,
  onConnect,
  onManage,
  onToggle,
}: WorkspaceServerHeldSectionProps) {
  const { t } = useTranslation("externalAccounts");
  const provider = descriptor ? connectorName(descriptor) : providerLabel(kind);
  const connectorCopy = descriptor
    ? connectorDescription(descriptor)
    : undefined;
  const bindingCopy =
    kind === "feishu"
      ? t("workspace.binding.feishu")
      : t("workspace.binding.serverHeld", { provider });
  const description = connectorCopy ? (
    <span className="grid gap-1">
      <span>{connectorCopy}</span>
      <span>{bindingCopy}</span>
    </span>
  ) : (
    bindingCopy
  );
  const own = mine.filter((account) => account.provider === kind);
  const others = theirs.filter((account) => account.provider === kind);

  return (
    <ConnectorSection
      actions={
        <>
          {kind === "feishu" ? (
            <Button
              disabled={busy || Boolean(readOnlyReason) || authorizing}
              onClick={() => onConnect()}
              size="sm"
              variant={own.length ? "secondary" : "primary"}
            >
              {t("workspace.connect", { provider })}
            </Button>
          ) : null}
          <Button onClick={onManage} size="sm" variant="ghost">
            {t("workspace.manage")}
            <ChevronRight size={14} />
          </Button>
        </>
      }
      description={description}
      holding={<CredentialHolding holding="server_held" name={provider} />}
      name={provider}
    >
      {own.length === 0 ? (
        <MutedText>{t("workspace.empty", { provider })}</MutedText>
      ) : (
        <DividedList>
          {own.map((account) => (
            <li
              className="fdy-xacc-binding-row flex min-w-0 items-start justify-between gap-3"
              key={account.id}
            >
              <CheckLabel>
                <Checkbox
                  checked={bound.has(account.id)}
                  disabled={
                    busy ||
                    Boolean(readOnlyReason) ||
                    (!accountUsable(account) && !bound.has(account.id))
                  }
                  onChange={(event) =>
                    onToggle(account, event.currentTarget.checked)
                  }
                />
                <span>
                  {t("workspace.use", { name: personName(account) })}
                  {customLabel(account) ||
                  account.appName ||
                  organisationLabel(account) ? (
                    <small>
                      {[
                        customLabel(account),
                        account.appName,
                        organisationLabel(account),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  ) : null}
                  {!accountUsable(account) ? (
                    <small>
                      {t("workspace.notUsable", {
                        status: statusLabel(account.status),
                      })}
                    </small>
                  ) : null}
                </span>
              </CheckLabel>
              {!accountUsable(account) && kind === "feishu" ? (
                <Button
                  disabled={busy || Boolean(readOnlyReason)}
                  size="sm"
                  onClick={() => onConnect(account)}
                >
                  {t("workspace.authorize")}
                </Button>
              ) : null}
              <Badge tone={statusTone(account.status)}>
                {statusLabel(account.status)}
              </Badge>
            </li>
          ))}
        </DividedList>
      )}
      {others.length > 0 ? (
        <>
          <MutedText>{t("workspace.others")}</MutedText>
          <DividedList>
            {others.map((account) => (
              <li
                className="fdy-xacc-binding-row flex min-w-0 items-start justify-between gap-3"
                key={account.id}
              >
                <Identity as="span">
                  <strong>{account.label}</strong>
                </Identity>
                <Badge tone={statusTone(account.status)}>
                  {statusLabel(account.status)}
                </Badge>
              </li>
            ))}
          </DividedList>
        </>
      ) : null}
    </ConnectorSection>
  );
}
