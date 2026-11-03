import type { ConnectorDescriptor } from "@bd777/foundry-protocol";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../components/ui/copy-button";
import { Dialog } from "../../components/ui/dialog";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { joinNames } from "../../lib/device-sharing";
import { connectorName } from "./connector-text";

const addCommand = "foundry-worker extension add <folder>";
const extensionSpec =
  "https://github.com/BD777/foundry/blob/main/docs/connector-extensions.md";
const requestService = "https://github.com/BD777/foundry/issues/new";

/**
 * Where a service Foundry does not list comes from, by whose it is: a
 * company's or a person's own tool connects through a connector extension
 * installed on the device; a public one is built into Foundry. Also points
 * extension authors at the spec, and lists the extensions already on the
 * person's devices.
 */
export function AddConnectorDialog({
  catalog,
  open,
  onClose,
}: {
  catalog: ConnectorDescriptor[];
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("externalAccounts");
  const builtIn = catalog.filter((entry) => !entry.extension);
  const extensions = new Map<
    string,
    { name: string; version: string; provides: string[] }
  >();
  for (const entry of catalog) {
    if (!entry.extension) continue;
    const known = extensions.get(entry.extension.id) ?? {
      name: entry.extension.name,
      version: entry.extension.version,
      provides: [],
    };
    known.provides.push(connectorName(entry));
    extensions.set(entry.extension.id, known);
  }
  return (
    <Dialog
      description={t("addConnector.description", {
        names: joinNames(
          builtIn.map(connectorName),
          i18n.resolvedLanguage ?? i18n.language,
        ),
      })}
      onClose={onClose}
      open={open}
      title={t("addConnector.title")}
    >
      <div className="fdy-xacc-add-connector">
        <section aria-labelledby="fdy-add-connector-own">
          <h3 id="fdy-add-connector-own">{t("addConnector.own.title")}</h3>
          <p>{t("addConnector.own.body")}</p>
          <span className="fdy-xacc-command">
            <TerminalBlock
              lines={[{ id: "add", prompt: "$", value: addCommand }]}
            />
            <CopyButton
              copiedLabel={t("setupSteps.signIn.copied")}
              label={t("setupSteps.signIn.copy", { command: addCommand })}
              text={addCommand}
            />
          </span>
          <p className="fdy-xacc-muted">{t("addConnector.own.after")}</p>
          {extensions.size > 0 ? (
            <>
              <h4>{t("addConnector.installed")}</h4>
              <ul className="fdy-xacc-add-installed">
                {[...extensions.entries()].map(([id, extension]) => (
                  <li key={id}>
                    {t("addConnector.installedRow", {
                      name: extension.name,
                      version: extension.version,
                      provides: extension.provides.join(", "),
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <section aria-labelledby="fdy-add-connector-public">
          <h3 id="fdy-add-connector-public">
            {t("addConnector.public.title")}
          </h3>
          <p>{t("addConnector.public.body")}</p>
          <a href={requestService} rel="noreferrer" target="_blank">
            {t("addConnector.public.link")}
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </section>
        <section aria-labelledby="fdy-add-connector-author">
          <h3 id="fdy-add-connector-author">
            {t("addConnector.author.title")}
          </h3>
          <p>{t("addConnector.author.body")}</p>
          <a href={extensionSpec} rel="noreferrer" target="_blank">
            {t("addConnector.author.link")}
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </section>
      </div>
    </Dialog>
  );
}
