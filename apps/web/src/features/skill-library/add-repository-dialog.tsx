import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  RepositorySkillFolder,
  SkillRepository,
} from "@bd777/foundry-protocol";
import {
  addSkillRepository,
  importRepositorySkills,
  listRepositorySkills,
  previewSkillRepository,
  type SkillRepositoryPreview,
} from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { RepositorySkillList } from "./repository-skill-list";
import { canReadWith, RepositorySourceFields } from "./repository-source";

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

type Mode = "bundle" | "pick";

/** The server answered that the repository's host did not answer it. */
const serverCouldNotRead = (cause: unknown) =>
  (cause as { status?: number } | undefined)?.status === 502;

/**
 * Follows a git repository or npm package: as one bundle (all of its
 * skills) or by picking skills. Either way the skills move to new releases
 * by themselves. The server reads it, or one of the person's devices does
 * with its own settings when only that device can reach it. Given a
 * repository already followed by picking, it opens on choosing more of its
 * skills.
 */
export function AddRepositoryDialog({
  repository,
  devices,
  onClose,
  onChanged,
}: {
  repository?: SkillRepository;
  devices: DeviceProjection[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [url, setURL] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [registry, setRegistry] = useState("");
  const [suggestDevice, setSuggestDevice] = useState(false);
  const [preview, setPreview] = useState<SkillRepositoryPreview>();
  const [mode, setMode] = useState<Mode>("pick");
  const [available, setAvailable] = useState<RepositorySkillFolder[]>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(Boolean(repository));
  const [error, setError] = useState("");
  const choosing = Boolean(repository || preview);
  const npm = url.trim().startsWith("npm:");
  const folders = repository ? available : preview?.available;

  useEffect(() => {
    if (!repository) return;
    let cancelled = false;
    listRepositorySkills(repository.id)
      .then((view) => {
        if (!cancelled) setAvailable(view.available);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setSuggestDevice(false);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
      setSuggestDevice(
        !deviceId && serverCouldNotRead(cause) && devices.some(canReadWith),
      );
    } finally {
      setBusy(false);
    }
  };

  const source = { deviceId, registry: npm ? registry.trim() : "" };
  const find = () =>
    run(async () => {
      const found = await previewSkillRepository({
        url,
        ref,
        subpath,
        ...source,
      });
      setPreview(found);
      setMode(found.suggestBundle ? "bundle" : "pick");
    });

  const add = () =>
    run(async () => {
      if (repository) {
        await importRepositorySkills(repository.id, [...chosen]);
      } else {
        await addSkillRepository({
          url,
          ref,
          subpath,
          mode,
          dirs: mode === "pick" ? [...chosen] : [],
          ...source,
        });
      }
      await onChanged();
      onClose();
    });

  const toggle = (dir: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const bundle = !repository && mode === "bundle";
  const versionLabel = preview?.release
    ? t("library.repo.latestRelease", { tag: preview.release })
    : ref || t("library.repo.defaultBranch");
  const label = repository?.label ?? preview?.label ?? "";

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-connection-assign-overlay" />
        <Dialog.Content className="fdy-connection-assign-dialog">
          <header className="fdy-connection-assign-header">
            <div>
              <Dialog.Title>
                {choosing
                  ? t("library.repo.chooseTitle", { label })
                  : t("library.repo.addTitle")}
              </Dialog.Title>
              <Dialog.Description>
                {choosing
                  ? t("library.repo.chooseDescription")
                  : t("library.repo.addDescription")}
              </Dialog.Description>
            </div>
          </header>
          <form
            aria-busy={busy}
            className="fdy-skill-promotion-body fdy-skill-repo-form"
            id="fdy-skill-repo-form"
            onSubmit={(event) => {
              event.preventDefault();
              void (choosing ? add() : find());
            }}
          >
            {!choosing ? (
              <>
                <label className="fdy-skill-repo-field">
                  {t("library.repo.url")}
                  <TextInput
                    autoFocus
                    disabled={busy}
                    onChange={(event) => setURL(event.currentTarget.value)}
                    placeholder={t("library.repo.urlPlaceholder")}
                    required
                    tone="boxed"
                    value={url}
                  />
                </label>
                <div className="fdy-skill-repo-field-row">
                  <label className="fdy-skill-repo-field">
                    {t("library.repo.ref")}
                    <TextInput
                      disabled={busy}
                      onChange={(event) => setRef(event.currentTarget.value)}
                      placeholder={t("library.repo.refPlaceholder")}
                      tone="boxed"
                      value={ref}
                    />
                  </label>
                  <label className="fdy-skill-repo-field">
                    {t("library.repo.subpath")}
                    <TextInput
                      disabled={busy}
                      onChange={(event) =>
                        setSubpath(event.currentTarget.value)
                      }
                      placeholder={t("library.repo.subpathPlaceholder")}
                      tone="boxed"
                      value={subpath}
                    />
                  </label>
                </div>
                <RepositorySourceFields
                  deviceId={deviceId}
                  devices={devices}
                  disabled={busy}
                  onDeviceChange={setDeviceId}
                  onRegistryChange={setRegistry}
                  registry={registry}
                  showRegistry={npm}
                />
                {busy ? (
                  <p role="status">
                    {deviceId
                      ? t("library.repo.readingOnDevice", {
                          device:
                            devices.find((device) => device.id === deviceId)
                              ?.label ?? "",
                        })
                      : t("library.repo.reading")}
                  </p>
                ) : null}
              </>
            ) : !folders ? (
              busy ? (
                <p role="status">{t("library.repo.reading")}</p>
              ) : null
            ) : (
              <>
                {!repository ? (
                  <>
                    <SegmentedControl<Mode>
                      aria-label={t("library.repo.modeLabel")}
                      onValueChange={setMode}
                      options={[
                        {
                          value: "bundle",
                          label: t("library.repo.modeBundle"),
                        },
                        { value: "pick", label: t("library.repo.modePick") },
                      ]}
                      size="sm"
                      value={mode}
                    />
                    <p className="fdy-skill-repo-mode-note">
                      {bundle
                        ? t("library.repo.bundleNote", {
                            count: folders.length,
                            version: versionLabel,
                          })
                        : t("library.repo.pickNote", {
                            version: versionLabel,
                          })}
                      {preview?.suggestBundle && !bundle
                        ? ` ${t("library.repo.bundleSuggested")}`
                        : ""}
                    </p>
                  </>
                ) : null}
                <RepositorySkillList
                  chosen={bundle ? undefined : chosen}
                  disabled={busy}
                  folders={folders}
                  onChooseAll={(dirs) => setChosen(new Set(dirs))}
                  onToggle={toggle}
                />
              </>
            )}
            {error ? (
              <p role="alert" className="fdy-skill-error">
                {error}
              </p>
            ) : null}
            {suggestDevice ? (
              <p className="fdy-skill-repo-mode-note">
                {t("library.repo.serverUnreachableHint")}
              </p>
            ) : null}
          </form>
          <footer className="fdy-connection-assign-actions fdy-skill-dialog-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {choosing
                ? t("common:actions.close")
                : t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={
                busy || (choosing ? !bundle && chosen.size === 0 : !url.trim())
              }
              form="fdy-skill-repo-form"
              type="submit"
            >
              {!choosing
                ? busy
                  ? t("library.repo.reading")
                  : t("library.repo.find")
                : bundle
                  ? t("library.repo.addBundle", { count: folders?.length ?? 0 })
                  : t("library.repo.addChosen", { count: chosen.size })}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
