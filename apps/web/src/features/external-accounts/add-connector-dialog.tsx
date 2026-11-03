import type { ConnectorDescriptor } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../components/ui/copy-button";
import { Dialog } from "../../components/ui/dialog";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { connectorName } from "./connector-text";

const addCommand = "foundry-worker extension add <folder>";

/**
 * How a connector Foundry does not have gets here: its maintainers ship a
 * connector extension, its owner installs it on a device, and its
 * connectors join the page. Lists the extensions already on the person's
 * devices, by what they provide.
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
  const { t } = useTranslation("externalAccounts");
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
      description={t("addConnector.description")}
      onClose={onClose}
      open={open}
      title={t("addConnector.title")}
    >
      <div className="fdy-xacc-add-connector">
        <p>
          {t("addConnector.builtIn", {
            names: builtIn.map(connectorName).join(", "),
          })}
        </p>
        <ol className="fdy-xacc-add-steps">
          <li>{t("addConnector.stepGet")}</li>
          <li>
            <span>{t("addConnector.stepInstall")}</span>
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
          </li>
          <li>{t("addConnector.stepAppear")}</li>
        </ol>
        <p className="fdy-xacc-muted">{t("addConnector.trust")}</p>
        {extensions.size > 0 ? (
          <>
            <strong>{t("addConnector.installed")}</strong>
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
      </div>
    </Dialog>
  );
}
