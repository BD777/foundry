import { useTranslation } from "react-i18next";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { connectorTypes, type ConnectorType } from "../../lib/connector-types";
import { FeishuConnector } from "./feishu-connector";

export interface ConnectorsFeatureProps {
  currentUserId: string;
  isAdmin: boolean;
  onNotice: (message: string) => void;
  onTabChange: (tab: ConnectorType) => void;
  tab: ConnectorType;
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
        options={connectorTypes.map((value) => ({
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
