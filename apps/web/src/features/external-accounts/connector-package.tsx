import type {
  ConnectorPackageDevice,
  ConnectorPackageView,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { Save } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { setConnectorPackageDevices } from "../../api";
import { AppLink } from "../../components/ui/app-link";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DividedList } from "../../components/ui/divided-list";
import { Checkbox, FieldHint } from "../../components/ui/field";
import { SectionHead, SectionPanel } from "../../components/ui/section-panel";
import { MutedText } from "../../components/ui/text";
import { skillLibraryRepositoryHref } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";

function selectedIds(view: ConnectorPackageView): Set<string> {
  return new Set(
    view.devices
      .filter((device) => device.selected)
      .map((device) => device.deviceId),
  );
}

function sameSelection(
  view: ConnectorPackageView,
  selected: Set<string>,
): boolean {
  const initial = selectedIds(view);
  return (
    initial.size === selected.size &&
    [...initial].every((deviceId) => selected.has(deviceId))
  );
}

/** The version the package's tools run, as the upstream commit's short form. */
export function packageToolVersion(
  repository: SkillRepository | undefined,
): string | undefined {
  const commit = (
    repository?.commit ?? repository?.versions?.[0]?.commit
  )?.trim();
  return commit ? commit.slice(0, 7) : undefined;
}

/**
 * A connector package's person-level enablement: one checkbox per device,
 * why a device cannot be selected, the tools and their upstream commit, and
 * links to the Skills in the same bundle.
 */
export function ConnectorPackage({
  view,
  repository,
  onSaved,
  onNotice,
}: {
  view: ConnectorPackageView;
  repository?: SkillRepository;
  onSaved: (view: ConnectorPackageView) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [selected, setSelected] = useState(() => selectedIds(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const baseId = useId();

  useEffect(() => {
    setSelected(selectedIds(view));
  }, [view]);

  const version = packageToolVersion(repository);
  const skills = (repository?.skills ?? []).filter((skill) => !skill.retired);
  const changed = !sameSelection(view, selected);

  function reasonText(device: ConnectorPackageDevice): string {
    const reason = device.reason?.trim() ?? "";
    if (reason === "The device is offline.") {
      return t("connectorPackage.reasons.offline");
    }
    if (reason === "The device has not reported a supported platform.") {
      return t("connectorPackage.reasons.platformUnknown");
    }
    if (reason === "Foundry tools are supported on Linux and macOS only.") {
      return t("connectorPackage.reasons.platformUnsupported");
    }
    if (reason === "This device has no Node.js runtime for repository tools.") {
      return t("connectorPackage.reasons.nodeMissing");
    }
    if (
      reason === "The device's connector state could not be read." ||
      reason === "The package names no repository-reading connector."
    ) {
      return t("connectorPackage.reasons.unavailable");
    }
    const connector = reason.match(
      /^The (.+) connector (?:is not available|is not ready) on this device\./,
    );
    if (connector) {
      return t("connectorPackage.reasons.connectorUnavailable", {
        connector: connector[1],
      });
    }
    const install = reason.match(
      /^Install the (.+) connector on this device\./,
    );
    if (install) {
      return t("connectorPackage.reasons.installConnector", {
        connector: install[1],
      });
    }
    const signIn = reason.match(
      /^Sign in to the (.+) connector on this device\./,
    );
    if (signIn) {
      return t("connectorPackage.reasons.signInConnector", {
        connector: signIn[1],
      });
    }
    return reason || t("connectorPackage.reasons.unavailable");
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const updated = await setConnectorPackageDevices(view.connector.kind, [
        ...selected,
      ]);
      setSelected(selectedIds(updated));
      onSaved(updated);
      onNotice(t("connectorPackage.saved"));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionPanel aria-busy={busy || undefined}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <SectionHead
          description={t("connectorPackage.description")}
          title={t("connectorPackage.title")}
        />
        <Badge tone={view.enabled ? "online" : "neutral"}>
          {view.enabled
            ? t("connectorPackage.enabled")
            : t("connectorPackage.notEnabled")}
        </Badge>
      </div>

      <DividedList density="compact">
        {view.devices.map((device, index) => {
          const hintId = `${baseId}-${index}`;
          const unavailable = !device.eligible;
          const canSuggest = device.eligible && !selected.has(device.deviceId);
          return (
            <li className="min-w-0" key={device.deviceId}>
              <label
                className="flex min-w-0 cursor-pointer items-start gap-2.5"
                htmlFor={`${hintId}-checkbox`}
              >
                <Checkbox
                  aria-describedby={hintId}
                  aria-label={t("connectorPackage.selectDevice", {
                    device: device.name,
                  })}
                  checked={selected.has(device.deviceId)}
                  className="mt-0.5 flex-none"
                  disabled={unavailable || busy}
                  id={`${hintId}-checkbox`}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(device.deviceId);
                      else next.delete(device.deviceId);
                      return next;
                    });
                  }}
                />
                <span className="grid min-w-0 gap-0.5">
                  <strong className="text-sm font-semibold text-ink">
                    {device.name}
                  </strong>
                  <FieldHint
                    as="small"
                    className="m-0"
                    id={hintId}
                    tone={
                      unavailable ? "warning" : canSuggest ? "info" : "muted"
                    }
                  >
                    {unavailable
                      ? t("connectorPackage.unavailable", {
                          reason: reasonText(device),
                        })
                      : canSuggest
                        ? t("connectorPackage.available")
                        : t("connectorPackage.selected")}
                  </FieldHint>
                </span>
              </label>
            </li>
          );
        })}
      </DividedList>

      <div className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <strong className="text-sm font-semibold text-ink">
            {t("connectorPackage.tools")}
          </strong>
          {version ? (
            <Badge dot={false} size="xs" tone="neutral">
              {version}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
          {view.connector.package?.tools.map((tool) => (
            <MutedText as="span" key={tool.command}>
              <span className="font-mono text-ink">{tool.command}</span>
              {" · "}
              {version ?? t("connectorPackage.versionPending")}
            </MutedText>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 gap-1.5">
        <strong className="text-sm font-semibold text-ink">
          {t("connectorPackage.skills")}
        </strong>
        {skills.length ? (
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {skills.map((skill) => (
              <AppLink
                className="text-sm text-ink underline decoration-line underline-offset-2 hover:text-brand"
                href={skillLibraryRepositoryHref(repository!.id, skill.skillId)}
                key={skill.skillId}
              >
                {skill.name || skill.dir}
              </AppLink>
            ))}
          </div>
        ) : (
          <MutedText>{t("connectorPackage.skillsPending")}</MutedText>
        )}
      </div>

      {error ? (
        <FieldHint as="div" className="m-0" tone="error">
          {t("connectorPackage.saveFailed", { error })}
        </FieldHint>
      ) : null}
      <div className="flex justify-end">
        <Button
          busy={busy}
          disabled={busy || selected.size === 0 || !changed}
          onClick={() => void save()}
          size="sm"
          variant="primary"
        >
          <Save aria-hidden="true" size={14} />
          {busy ? t("connectorPackage.saving") : t("connectorPackage.save")}
        </Button>
      </div>
    </SectionPanel>
  );
}
