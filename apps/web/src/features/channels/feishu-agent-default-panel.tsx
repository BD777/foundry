import { useTranslation } from "react-i18next";
import type { AgentProfileProjection } from "@bd777/foundry-protocol";
import type { WorkspaceAgentDefaults } from "../../api";
import {
  AgentDefaultFields,
  AgentDefaultPanel,
  type AgentDefaultChange,
} from "../../components/workspace/agent-default-fields";
import { agentDefaultAt } from "../../components/workspace/use-agent-defaults";
import { Skeleton } from "../../components/ui/loading";

/** The Feishu bot's default agent: what its new topics run with. */
export function FeishuAgentDefaultPanel({
  answer,
  deviceId,
  profiles,
  onChange,
}: {
  answer?: WorkspaceAgentDefaults;
  deviceId?: string;
  profiles: AgentProfileProjection[];
  onChange: (change: AgentDefaultChange) => Promise<void>;
}) {
  const { t } = useTranslation("agents");
  return (
    <AgentDefaultPanel intro={t("defaultAgent.channelIntro")}>
      {answer ? (
        <AgentDefaultFields
          accounts={answer.accounts}
          deviceId={deviceId}
          effective={answer.feishuBot}
          effectiveLabel={t("defaultAgent.effectiveTopic")}
          onChange={onChange}
          profiles={profiles}
          value={agentDefaultAt(answer, "feishu_bot")}
        />
      ) : (
        <Skeleton label={t("defaultAgent.loading")} rows={2} variant="rows" />
      )}
    </AgentDefaultPanel>
  );
}
