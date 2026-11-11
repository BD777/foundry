import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import type { ToastTone } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import { SectionHeader } from "../../components/ui/page-header";
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
      <SectionHeader
        title={t("executionDefault.workspaceTitle")}
        description={t("executionDefault.workspaceIntro")}
      />
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
