import { HardDrive, Info, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import {
  connectorHolding,
  type ConnectorType,
} from "../../lib/connector-types";

const facts = ["where", "who", "offline", "revoke"] as const;

/**
 * Where a connector's credentials live ("Credentials on each device" or
 * "Credentials on the server"), with an info button whose panel says what
 * that means: where the secret is, who can use it, what happens offline
 * and how to revoke it. Hover and keyboard focus preview the panel; a
 * click or tap pins it.
 */
export function CredentialHolding({ type }: { type: ConnectorType }) {
  const { t } = useTranslation("externalAccounts");
  const holding = connectorHolding[type];
  const label = t(`holding.${holding}.label`);
  const name = t(`providers.${type}`);
  return (
    <span className="fdy-xacc-holding" data-holding={holding}>
      {holding === "device_held" ? (
        <HardDrive aria-hidden="true" size={13} />
      ) : (
        <Server aria-hidden="true" size={13} />
      )}
      <span>{label}</span>
      <Popover
        className="fdy-xacc-holding-panel"
        label={t("holding.about", { label })}
        openOnHover
        trigger={
          <Button
            aria-label={t("holding.about", { label })}
            size="icon"
            variant="ghost"
          >
            <Info aria-hidden="true" size={14} />
          </Button>
        }
      >
        <dl>
          {facts.map((fact) => (
            <div key={fact}>
              <dt>{t(`holding.terms.${fact}`)}</dt>
              <dd>
                {fact === "revoke" && type === "aws"
                  ? t("holding.device_held.revokeLocal")
                  : t(`holding.${holding}.${fact}`, { name })}
              </dd>
            </div>
          ))}
        </dl>
      </Popover>
    </span>
  );
}
