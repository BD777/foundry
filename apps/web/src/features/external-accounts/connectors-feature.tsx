import { useTranslation } from "react-i18next";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { FeishuConnector } from "./feishu-connector";

/** One tab per kind of external service; the route names the open one. */
export const connectorTabs = ["feishu"] as const;
export type ConnectorTab = (typeof connectorTabs)[number];

export interface ConnectorsFeatureProps {
  currentUserId: string;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  onTabChange: (tab: ConnectorTab) => void;
  tab: ConnectorTab;
}

/**
 * The Connectors page: external services a person's sessions use under the
 * person's own identity, one tab per kind of service.
 */
export function ConnectorsFeature({
  onTabChange,
  tab,
  ...props
}: ConnectorsFeatureProps) {
  const { t } = useTranslation("externalAccounts");
  return (
    <PageSurface variant="connectors">
      <header className="fdy-xacc-intro">
        <span>
          <strong>{t("page.title")}</strong>
          <p>{t("page.intro")}</p>
        </span>
      </header>
      <SegmentedControl
        aria-label={t("page.tabs")}
        onValueChange={onTabChange}
        options={connectorTabs.map((value) => ({
          value,
          label: t(`providers.${value}`),
        }))}
        tone="navigation"
        value={tab}
      />
      {tab === "feishu" ? <FeishuConnector {...props} /> : null}
    </PageSurface>
  );
}
