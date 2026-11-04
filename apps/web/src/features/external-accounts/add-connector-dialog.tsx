import type { ConnectorDescriptor } from "@bd777/foundry-protocol";
import { ExternalLink, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../../components/ui/copy-button";
import { Dialog } from "../../components/ui/dialog";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { joinNames } from "../../lib/device-sharing";
import { connectorName } from "./connector-text";
import { MutedText } from "../../components/ui/text";
import { CommandLine } from "../../components/ui/command-line";
import { connectorStackClass } from "./connector-layout";
import { cn } from "../../lib/cn";

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
/** One way in per section, set off by a hairline; each starts with its case. */
const sectionClass = "grid min-w-0 gap-2";
const nextSectionClass = "border-t border-line pt-3.5";
const headingClass = "text-md font-semibold text-ink";
const linkClass =
  "inline-flex w-fit items-center gap-1 text-brand underline underline-offset-3";

export function AddConnectorDialog({
  catalog,
  open,
  onClose,
  onInstallFromRepository,
}: {
  catalog: ConnectorDescriptor[];
  open: boolean;
  onClose: () => void;
  /** Opens installing an extension from its git repository on a device. */
  onInstallFromRepository: () => void;
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
      <div className={connectorStackClass}>
        <section
          aria-labelledby="fdy-add-connector-own"
          className={sectionClass}
        >
          <h3 className={headingClass} id="fdy-add-connector-own">
            {t("addConnector.own.title")}
          </h3>
          <p>{t("addConnector.own.body")}</p>
          <Button
            className="w-fit"
            onClick={onInstallFromRepository}
            size="sm"
            variant="primary"
          >
            <GitBranch aria-hidden="true" size={14} />
            {t("addConnector.own.install")}
          </Button>
          <MutedText>{t("addConnector.own.orTerminal")}</MutedText>
          <CommandLine>
            <TerminalBlock
              lines={[{ id: "add", prompt: "$", value: addCommand }]}
            />
            <CopyButton
              copiedLabel={t("setupSteps.signIn.copied")}
              label={t("setupSteps.signIn.copy", { command: addCommand })}
              text={addCommand}
            />
          </CommandLine>
          <MutedText>{t("addConnector.own.after")}</MutedText>
          {extensions.size > 0 ? (
            <>
              <h4 className="mt-1 text-sm font-semibold text-ink">
                {t("addConnector.installed")}
              </h4>
              <ul className="grid gap-1 pl-5 text-ink-muted">
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
        <section
          aria-labelledby="fdy-add-connector-public"
          className={cn(sectionClass, nextSectionClass)}
        >
          <h3 className={headingClass} id="fdy-add-connector-public">
            {t("addConnector.public.title")}
          </h3>
          <p>{t("addConnector.public.body")}</p>
          <a
            className={linkClass}
            href={requestService}
            rel="noreferrer"
            target="_blank"
          >
            {t("addConnector.public.link")}
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </section>
        <section
          aria-labelledby="fdy-add-connector-author"
          className={cn(sectionClass, nextSectionClass)}
        >
          <h3 className={headingClass} id="fdy-add-connector-author">
            {t("addConnector.author.title")}
          </h3>
          <p>{t("addConnector.author.body")}</p>
          <a
            className={linkClass}
            href={extensionSpec}
            rel="noreferrer"
            target="_blank"
          >
            {t("addConnector.author.link")}
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </section>
      </div>
    </Dialog>
  );
}
