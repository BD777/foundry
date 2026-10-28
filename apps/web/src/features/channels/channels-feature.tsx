import { useTranslation } from "react-i18next";
import { ArrowRight, MessageSquareText } from "lucide-react";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  channelSections,
  channelTypes,
  type ChannelSectionProps,
} from "./channel-types";

export interface ChannelsFeatureProps extends ChannelSectionProps {
  /** Why the caller cannot manage this workspace's channels; nothing is
   * loaded. */
  readOnlyReason?: string;
  onOpenChats?: () => void;
}

/**
 * The workspace's Channels tab: how the workspace is reached. Web Chats is
 * always on; each other channel type has its section.
 */
export function ChannelsFeature({
  readOnlyReason,
  onOpenChats,
  ...props
}: ChannelsFeatureProps) {
  const { t } = useTranslation("channels");
  const { t: tAgents } = useTranslation("agents");
  return (
    <div className="fdy-channels">
      <div className="fdy-channels-web">
        <MessageSquareText size={18} aria-hidden />
        <span className="fdy-channels-web-text">
          <strong>{t("web.title")}</strong>
          <small>{t("web.detail")}</small>
          <small>{tAgents("defaultAgent.webUsesWorkspace")}</small>
        </span>
        {onOpenChats ? (
          <Button onClick={onOpenChats} size="sm" variant="link">
            {t("web.open")}
            <ArrowRight size={14} aria-hidden />
          </Button>
        ) : null}
      </div>
      {readOnlyReason ? (
        <Alert title={t("readOnlyTitle")}>{readOnlyReason}</Alert>
      ) : (
        channelTypes.map((type) => {
          const Section = channelSections[type];
          return (
            <section
              aria-label={t(`types.${type}.title`)}
              className="fdy-channels-section"
              key={type}
            >
              <Section {...props} />
            </section>
          );
        })
      )}
    </div>
  );
}
