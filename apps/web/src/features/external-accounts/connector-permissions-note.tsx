import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type { ConnectorDescriptor } from "@bd777/foundry-protocol";
import { MutedText } from "../../components/ui/text";
import { localized } from "./connector-text";

const linkClass =
  "inline-flex w-fit items-center gap-1 text-brand underline underline-offset-3";

/**
 * A connector whose permissions are not chosen at sign-in (DEV-136) says
 * where they come from instead of offering a picker it cannot honour.
 */
export function ConnectorPermissionsNote({
  connector,
}: {
  connector: ConnectorDescriptor;
}) {
  const { t } = useTranslation("externalAccounts");
  const permissions = connector.permissions;
  if (!permissions) return null;
  return (
    <MutedText as="small">
      {localized(permissions.description, permissions.descriptions)}{" "}
      {permissions.url ? (
        <a
          className={linkClass}
          href={permissions.url}
          rel="noreferrer"
          target="_blank"
        >
          {t("permissions.manage")}
          <ExternalLink aria-hidden="true" size={13} />
        </a>
      ) : null}
    </MutedText>
  );
}
