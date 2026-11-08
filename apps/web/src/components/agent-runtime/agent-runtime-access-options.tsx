import { Check, Hand, ShieldAlert } from "lucide-react";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { MenuHeading, MenuOption, MenuSection } from "./runtime-menu-parts";
import type {
  ControlledRuntime,
  EffectiveClaudePermission,
} from "./agent-runtime-labels";

const claudePermissionModes: EffectiveClaudePermission[] = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
];

const codexSandboxModes: CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

const codexApprovalPolicies: CodexApprovalPolicy[] = [
  "untrusted",
  "on-request",
  "never",
];

const optionIconClass = "justify-self-center text-ink-faint";
const checkIcon = (
  <Check className="justify-self-center text-brand-dark" size={17} />
);

/** The permissions menu's choices for the selected runtime. */
export function AgentAccessOptions({
  claudePermission,
  codexApprovalPolicy,
  codexSandboxMode,
  onClaudePermissionChange,
  onCodexApprovalPolicyChange,
  onCodexSandboxModeChange,
  selectedRuntime,
}: {
  claudePermission: EffectiveClaudePermission;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexSandboxMode: CodexSandboxMode;
  onClaudePermissionChange: (value: EffectiveClaudePermission) => void;
  onCodexApprovalPolicyChange: (value: CodexApprovalPolicy) => void;
  onCodexSandboxModeChange: (value: CodexSandboxMode) => void;
  selectedRuntime: ControlledRuntime;
}) {
  const { t } = useTranslation("agents");
  if (selectedRuntime === "claude") {
    return (
      <>
        <MenuHeading>{t("controls.claudePermission")}</MenuHeading>
        {claudePermissionModes.map((mode) => (
          <MenuOption
            checkIcon={checkIcon}
            icon={<Hand className={optionIconClass} size={18} />}
            key={mode}
            onClick={() => onClaudePermissionChange(mode)}
            selected={mode === claudePermission}
            summary={t(`claudePermissionSummary.${mode}`)}
            title={t(`claudePermission.${mode}`)}
          />
        ))}
      </>
    );
  }
  return (
    <>
      <MenuHeading>{t("controls.codexPermissions")}</MenuHeading>
      <MenuSection>{t("controls.sandbox")}</MenuSection>
      {codexSandboxModes.map((mode) => (
        <MenuOption
          checkIcon={checkIcon}
          icon={<ShieldAlert className={optionIconClass} size={18} />}
          key={mode}
          onClick={() => onCodexSandboxModeChange(mode)}
          selected={mode === codexSandboxMode}
          summary={t(`codexSandboxSummary.${mode}`)}
          title={t(`codexSandbox.${mode}`)}
          tooltip={mode}
        />
      ))}
      <MenuSection>{t("controls.approval")}</MenuSection>
      {codexApprovalPolicies.map((policy) => (
        <MenuOption
          checkIcon={checkIcon}
          icon={<Hand className={optionIconClass} size={18} />}
          key={policy}
          onClick={() => onCodexApprovalPolicyChange(policy)}
          selected={policy === codexApprovalPolicy}
          summary={t(`codexApprovalSummary.${policy}`)}
          title={t(`codexApproval.${policy}`)}
          tooltip={policy}
        />
      ))}
    </>
  );
}
