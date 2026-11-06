import type { ConnectorHolding } from "@bd777/foundry-protocol";
import { HardDrive, Info, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";

const facts = ["where", "who", "offline", "revoke"] as const;

/**
 * Where a connector's credentials live ("Credentials on each device" or
 * "Credentials on the server"), with an info button whose panel says what
 * that means: where the secret is, who can use it, what happens offline
 * and how to revoke it. Hover and keyboard focus preview the panel; a
 * click or tap pins it.
 */
export function CredentialHolding({
  holding,
  name,
  signOutLocal = false,
}: {
  holding: ConnectorHolding;
  /** The connector's name, as the page shows it. */
  name: string;
  /** Signed out in the tool's own terminal, not from the page. */
  signOutLocal?: boolean;
}) {
  const { t } = useTranslation("externalAccounts");
  const label = t(`holding.${holding}.label`);
  return (
    <span
      className="fdy-xacc-holding inline-flex min-w-0 items-center gap-1.5 text-xs leading-[1.4] text-ink-muted [&>svg]:flex-none [&>svg]:text-ink-faint"
      data-holding={holding}
    >
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
        <dl className="grid gap-1.5 [&_dd]:font-normal [&_dt]:font-bold">
          {facts.map((fact) => (
            <div key={fact}>
              <dt>{t(`holding.terms.${fact}`)}</dt>
              <dd>
                {fact === "revoke" && signOutLocal
                  ? t("holding.device_held.revokeLocal", { name })
                  : t(`holding.${holding}.${fact}`, { name })}
              </dd>
            </div>
          ))}
        </dl>
      </Popover>
    </span>
  );
}
