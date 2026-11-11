import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import { ExecutionDefaultFields } from "../../components/workspace/execution-default-fields";

/** The model every new session runs on unless a workspace chooses its own. */
export function GlobalExecutionDefault({
  profiles,
  servers,
  onNotice,
}: {
  profiles: AgentProfileProjection[];
  servers: ProfileDefinition[];
  onNotice: (message: string, tone?: "success" | "error") => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <SectionPanel className="grid min-w-0 gap-3">
      <SectionHeader
        level={3}
        title={t("executionDefault.globalTitle")}
        description={t("executionDefault.globalIntro")}
      />
      <ExecutionDefaultFields
        profiles={profiles}
        servers={servers}
        onNotice={onNotice}
      />
    </SectionPanel>
  );
}
