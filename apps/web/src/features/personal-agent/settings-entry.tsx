import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  ExternalProviderApp,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import { getExternalAccounts } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import type { InterfaceMode } from "../../lib/assistant-settings-sections";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import {
  SettingsCheck,
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

const interfaceModes: InterfaceMode[] = ["full", "simple"];

/** The Feishu apps the person may pick; none when Connectors can't be read. */
function useFeishuApps(): ExternalProviderApp[] {
  const [apps, setApps] = useState<ExternalProviderApp[]>([]);
  useEffect(() => {
    let current = true;
    getExternalAccounts().then(
      (view) => {
        if (current)
          setApps(view.apps.filter((app) => app.provider === "feishu"));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  return apps;
}

/** Where the person meets the assistant and when it may speak up. */
export function EntrySection({
  draft,
  change,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
}) {
  const { t } = useTranslation("personalAgent");
  const apps = useFeishuApps();
  const appOptions = [
    { value: "", label: t("settings.entry.feishuAppDefault") },
    ...apps.map((app) => ({ value: app.id, label: app.appName || app.label })),
  ];
  if (
    draft.feishuAppId &&
    !appOptions.some((option) => option.value === draft.feishuAppId)
  )
    appOptions.push({ value: draft.feishuAppId, label: draft.feishuAppId });
  return (
    <>
      <SettingsGroup>
        <SettingsCheck
          checked={draft.homePage}
          label={t("settings.entry.homePage")}
          onChange={(homePage) => change({ homePage })}
        />
        <SettingsField
          hint={t("settings.entry.interfaceHint")}
          label={t("settings.entry.interface")}
        >
          <SegmentedControl
            aria-label={t("settings.entry.interface")}
            className="fdy-pa-segments"
            onValueChange={(mode) =>
              change({ simpleInterface: mode === "simple" })
            }
            options={interfaceModes.map((value) => ({
              value,
              label: t(`settings.entry.interfaces.${value}`),
            }))}
            size="sm"
            value={draft.simpleInterface ? "simple" : "full"}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title={t("settings.entry.feishuTitle")}>
        <SettingsCheck
          checked={draft.feishuDirectChat}
          label={t("settings.entry.feishuDirectChat")}
          onChange={(feishuDirectChat) => change({ feishuDirectChat })}
        />
        <SettingsField
          hint={
            <>
              {t("settings.entry.feishuHint")}{" "}
              <Button
                onClick={() => navigateToConnectors("feishu")}
                size="inline"
                variant="link"
              >
                {t("settings.entry.openConnectors")}
                <ArrowRight aria-hidden="true" size={13} />
              </Button>
            </>
          }
          label={t("settings.entry.feishuApp")}
        >
          <SelectMenu
            ariaLabel={t("settings.entry.feishuApp")}
            className="fdy-pa-select"
            disabled={!draft.feishuDirectChat}
            onChange={(feishuAppId) => change({ feishuAppId })}
            options={appOptions}
            value={draft.feishuAppId}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title={t("settings.entry.digestTitle")}>
        <SettingsCheck
          checked={draft.dailyDigest}
          label={t("settings.entry.dailyDigest")}
          onChange={(dailyDigest) => change({ dailyDigest })}
        />
        <SettingsField
          htmlFor="fdy-pa-digest-time"
          label={t("settings.entry.dailyDigestTime")}
        >
          <TextInput
            className="fdy-pa-time"
            disabled={!draft.dailyDigest}
            id="fdy-pa-digest-time"
            onChange={(event) =>
              change({ dailyDigestTime: event.target.value })
            }
            tone="boxed"
            type="time"
            value={draft.dailyDigestTime}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title={t("settings.entry.hoursTitle")}>
        <div className="fdy-pa-inline">
          <SettingsField
            htmlFor="fdy-pa-hours-start"
            label={t("settings.entry.activeHoursStart")}
          >
            <TextInput
              className="fdy-pa-time"
              id="fdy-pa-hours-start"
              onChange={(event) =>
                change({ activeHoursStart: event.target.value })
              }
              tone="boxed"
              type="time"
              value={draft.activeHoursStart}
            />
          </SettingsField>
          <SettingsField
            htmlFor="fdy-pa-hours-end"
            label={t("settings.entry.activeHoursEnd")}
          >
            <TextInput
              className="fdy-pa-time"
              id="fdy-pa-hours-end"
              onChange={(event) =>
                change({ activeHoursEnd: event.target.value })
              }
              tone="boxed"
              type="time"
              value={draft.activeHoursEnd}
            />
          </SettingsField>
        </div>
        <p className="fdy-pa-field-hint">{t("settings.entry.hoursHint")}</p>
        <SettingsCheck
          checked={draft.urgentAnytime}
          label={t("settings.entry.urgentAnytime")}
          onChange={(urgentAnytime) => change({ urgentAnytime })}
        />
      </SettingsGroup>
    </>
  );
}
