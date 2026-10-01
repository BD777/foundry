import { Trans, useTranslation } from "react-i18next";
import { SetupFlow } from "../components/ui/setup-flow";

/** Shown where work needs a device and none is connected yet. */
export function ConnectDeviceSetup({
  onOpenDevices,
}: {
  onOpenDevices: () => void;
}) {
  const { t } = useTranslation("shell");
  return (
    <SetupFlow
      actionLabel={t("setup.action")}
      body={
        <Trans i18nKey="setup.body" ns="shell" components={{ em: <em /> }} />
      }
      kicker={t("setup.kicker")}
      onAction={onOpenDevices}
      status={t("setup.status")}
      steps={[
        {
          hint: t("setup.addDeviceHint"),
          number: "1",
          state: "primary",
          title: t("setup.addDevice"),
        },
        { hint: t("setup.agentsHint"), number: "2", title: t("setup.agents") },
        {
          hint: t("setup.firstIssueHint"),
          number: "3",
          title: t("setup.firstIssue"),
        },
      ]}
      title={t("setup.title")}
    />
  );
}
