import type {
  ConnectorExtensionRepository,
  DeviceConnectorDevice,
  ExtensionReplyPayload,
} from "@bd777/foundry-protocol";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { installDeviceExtension } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Spinner } from "../../components/ui/loading";
import { SelectMenu } from "../../components/ui/select-menu";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";
import { stateOf } from "./device-held-format";
import { FormFieldGroup, FormLayout } from "../../components/ui/form-field";
import { MutedText } from "../../components/ui/text";

export interface ExtensionInstallTarget {
  /** The extension's name, when installing one the page already knows. */
  name?: string;
  /** Known source (another device's copy); the person types one otherwise. */
  source?: ConnectorExtensionRepository;
  /** The device to install on, when the person picked it already. */
  deviceId?: string;
}

/** A GitHub https remote: a private one needs the device's GitHub sign-in. */
function onGitHub(git: string): boolean {
  return /^https:\/\/github\.com\//.test(git.trim());
}

/**
 * Installing a connector extension on one of the person's devices from the
 * git folder it is published in: what will be fetched (the repository, its
 * folder and branch), onto which device, and that it runs as the person
 * there. The device fetches it with its own git login; for a GitHub
 * repository that is the GitHub CLI connector's sign-in on that device.
 */
export function ExtensionInstallDialog({
  target,
  devices,
  onClose,
  onInstalled,
}: {
  target?: ExtensionInstallTarget;
  devices: DeviceConnectorDevice[];
  onClose: () => void;
  onInstalled: (deviceId: string, reply: ExtensionReplyPayload) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const id = useId();
  const known = target?.source;
  const [git, setGit] = useState(known?.git ?? "");
  const [path, setPath] = useState(known?.path ?? "");
  const [ref, setRef] = useState(known?.ref ?? "");
  const firstOnline = devices.find((device) => device.online)?.deviceId;
  const [deviceId, setDeviceId] = useState(
    target?.deviceId ?? firstOnline ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [triedEmpty, setTriedEmpty] = useState(false);
  const device = devices.find((entry) => entry.deviceId === deviceId);
  const github = device ? stateOf(device, "github") : undefined;
  const needsGitHub =
    onGitHub(git) && device?.online && github && !github.signedIn;

  async function install(event: FormEvent) {
    event.preventDefault();
    if (!git.trim()) {
      setTriedEmpty(true);
      return;
    }
    if (!device?.online) return;
    setBusy(true);
    setError("");
    try {
      const reply = await installDeviceExtension(device.deviceId, {
        git: git.trim(),
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      onInstalled(device.deviceId, reply);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = target?.name
    ? t("extensionInstall.titleNamed", { name: target.name })
    : t("extensionInstall.title");
  return (
    <Dialog
      busy={busy}
      description={t("extensionInstall.description")}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {t("extensionInstall.cancel")}
          </Button>
          <Button
            aria-busy={busy || undefined}
            disabled={busy || !device?.online}
            form={`${id}-form`}
            type="submit"
            variant="primary"
          >
            {busy ? <Spinner /> : null}
            {busy
              ? t("extensionInstall.installing", { device: device?.name })
              : t("extensionInstall.install", { device: device?.name ?? "" })}
          </Button>
        </>
      }
      onClose={onClose}
      open={Boolean(target)}
      title={title}
    >
      <FormLayout
        as="form"
        id={`${id}-form`}
        onSubmit={(event) => void install(event)}
      >
        {known ? (
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-sm [&_code]:font-mono [&_code]:text-xs [&>dd]:min-w-0 [&>dd]:wrap-anywhere [&>dt]:text-ink-muted">
            <dt>{t("extensionInstall.repository")}</dt>
            <dd>
              <code>{known.git}</code>
            </dd>
            {known.path ? (
              <>
                <dt>{t("extensionInstall.folder")}</dt>
                <dd>
                  <code>{known.path}</code>
                </dd>
              </>
            ) : null}
            <dt>{t("extensionInstall.ref")}</dt>
            <dd>
              {known.ref ? (
                <code>{known.ref}</code>
              ) : (
                t("extensionInstall.defaultBranch")
              )}
            </dd>
          </dl>
        ) : (
          <>
            <FormFieldGroup className="fdy-xacc-field">
              <label htmlFor={`${id}-git`}>
                {t("extensionInstall.repository")}
              </label>
              <TextInput
                aria-describedby={`${id}-git-hint`}
                aria-invalid={triedEmpty && !git.trim() ? true : undefined}
                autoComplete="off"
                id={`${id}-git`}
                onChange={(event) => setGit(event.target.value)}
                placeholder={t("extensionInstall.repositoryPlaceholder")}
                spellCheck={false}
                tone="boxed"
                value={git}
              />
              <FieldHint
                as="small"
                className={
                  triedEmpty && !git.trim() ? undefined : "text-ink-faint"
                }
                id={`${id}-git-hint`}
                tone={triedEmpty && !git.trim() ? "error" : undefined}
              >
                {triedEmpty && !git.trim()
                  ? t("extensionInstall.repositoryMissing")
                  : t("extensionInstall.repositoryHelp")}
              </FieldHint>
            </FormFieldGroup>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3.5">
              <FormFieldGroup className="fdy-xacc-field">
                <label htmlFor={`${id}-path`}>
                  {t("extensionInstall.folder")}
                  <small className="font-normal text-ink-faint">
                    {" · "}
                    {t("signInChooser.optional")}
                  </small>
                </label>
                <TextInput
                  autoComplete="off"
                  id={`${id}-path`}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={t("extensionInstall.folderPlaceholder")}
                  spellCheck={false}
                  tone="boxed"
                  value={path}
                />
              </FormFieldGroup>
              <FormFieldGroup className="fdy-xacc-field">
                <label htmlFor={`${id}-ref`}>
                  {t("extensionInstall.ref")}
                  <small className="font-normal text-ink-faint">
                    {" · "}
                    {t("signInChooser.optional")}
                  </small>
                </label>
                <TextInput
                  autoComplete="off"
                  id={`${id}-ref`}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder={t("extensionInstall.refPlaceholder")}
                  spellCheck={false}
                  tone="boxed"
                  value={ref}
                />
              </FormFieldGroup>
            </div>
          </>
        )}
        {target?.deviceId ? null : (
          <FormFieldGroup className="fdy-xacc-field">
            <span>{t("extensionInstall.device")}</span>
            <SelectMenu
              ariaLabel={t("extensionInstall.device")}
              insideDialog
              onChange={setDeviceId}
              options={devices.map((entry) => ({
                value: entry.deviceId,
                label: entry.name,
                disabled: !entry.online,
                detail: entry.online
                  ? undefined
                  : t("extensionInstall.offline"),
              }))}
              placeholder={t("extensionInstall.chooseDevice")}
              value={deviceId}
            />
          </FormFieldGroup>
        )}
        {needsGitHub ? (
          <Alert
            title={t("extensionInstall.githubHint", { device: device!.name })}
            tone="info"
          >
            <Button
              onClick={() => navigateToConnectors("github")}
              size="sm"
              variant="secondary"
            >
              {t("extensionInstall.githubOpen")}
            </Button>
          </Alert>
        ) : null}
        <MutedText>
          {t("extensionInstall.trust", { device: device?.name ?? "" })}
        </MutedText>
        {error ? <Alert title={error} tone="error" /> : null}
      </FormLayout>
    </Dialog>
  );
}
