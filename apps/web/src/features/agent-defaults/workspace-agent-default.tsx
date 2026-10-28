import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import type { AgentProfileProjection } from "@bd777/foundry-protocol";
import type { ToastTone } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { AgentDefaultFields } from "../../components/workspace/agent-default-fields";
import {
  agentDefaultAt,
  useAgentDefaults,
} from "../../components/workspace/use-agent-defaults";
import { errorText } from "../../lib/errors";
import { Skeleton } from "../../components/ui/loading";

export interface WorkspaceAgentDefaultFeatureProps {
  workspaceId: string;
  deviceId?: string;
  profiles: AgentProfileProjection[];
  /** Why the caller cannot change it; they still see what applies. */
  readOnlyReason?: string;
  onNotice?: (message: string, tone?: ToastTone) => void;
}

/**
 * The workspace's default agent, in its Agents & execution tab: the
 * account, model and effort a new chat runs with when nobody picks one.
 */
export function WorkspaceAgentDefaultFeature({
  workspaceId,
  deviceId,
  profiles,
  readOnlyReason,
  onNotice,
}: WorkspaceAgentDefaultFeatureProps) {
  const { t } = useTranslation("agents");
  const { answer, save } = useAgentDefaults(workspaceId, {
    onError: (error) =>
      onNotice?.(
        t("defaultAgent.loadFailed", { error: errorText(error) }),
        "error",
      ),
  });
  return (
    <Panel className="fdy-agent-default-panel">
      <PanelHeader>
        <div className="fdy-agent-default-heading">
          <Bot size={18} aria-hidden />
          <div>
            <h2>{t("defaultAgent.title")}</h2>
            <p>{t("defaultAgent.intro")}</p>
          </div>
        </div>
      </PanelHeader>
      {answer ? (
        <AgentDefaultFields
          accounts={answer.accounts}
          deviceId={deviceId}
          disabled={Boolean(readOnlyReason)}
          effective={answer.effective}
          effectiveLabel={t("defaultAgent.effectiveWeb")}
          onChange={async (change) => {
            try {
              await save({ scope: "workspace", ...change });
              onNotice?.(t("defaultAgent.saved"));
            } catch (error) {
              onNotice?.(
                t("defaultAgent.saveFailed", { error: errorText(error) }),
                "error",
              );
            }
          }}
          profiles={profiles}
          value={agentDefaultAt(answer, "workspace")}
        />
      ) : (
        <Skeleton label={t("defaultAgent.loading")} rows={2} variant="rows" />
      )}
      {readOnlyReason ? (
        <FieldHint>{t("defaultAgent.readOnly")}</FieldHint>
      ) : null}
    </Panel>
  );
}
