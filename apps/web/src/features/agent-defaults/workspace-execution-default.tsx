import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import type { ToastTone } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { ExecutionDefaultFields } from "../../components/workspace/execution-default-fields";

export function WorkspaceExecutionDefaultFeature({
  profiles,
  servers,
  workspaceId,
  readOnlyReason,
  onNotice,
}: {
  profiles: AgentProfileProjection[];
  servers: ProfileDefinition[];
  workspaceId: string;
  readOnlyReason?: string;
  onNotice?: (message: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <Panel className="grid min-w-0 gap-4 p-5.5">
      <PanelHeader>
        <div>
          <h2>{t("executionDefault.workspaceTitle")}</h2>
          <p>{t("executionDefault.workspaceIntro")}</p>
        </div>
      </PanelHeader>
      <ExecutionDefaultFields
        disabled={Boolean(readOnlyReason)}
        onNotice={onNotice}
        profiles={profiles}
        servers={servers}
        workspaceId={workspaceId}
      />
      {readOnlyReason ? (
        <FieldHint>{t("executionDefault.readOnly")}</FieldHint>
      ) : null}
    </Panel>
  );
}
