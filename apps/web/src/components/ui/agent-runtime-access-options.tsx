import { Check, Hand, ShieldAlert } from "lucide-react";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
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
  "on-failure",
  "never",
];

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
        <div className="fdy-chat-popover-note">
          <span>{t("controls.claudePermission")}</span>
        </div>
        {claudePermissionModes.map((mode) => (
          <Button
            className="fdy-chat-menu-option"
            data-selected={mode === claudePermission}
            key={mode}
            onClick={() => onClaudePermissionChange(mode)}
            variant="ghost"
          >
            <Hand size={18} />
            <span>
              <strong>{t(`claudePermission.${mode}`)}</strong>
              <em>{t(`claudePermissionSummary.${mode}`)}</em>
            </span>
            {mode === claudePermission ? <Check size={17} /> : null}
          </Button>
        ))}
      </>
    );
  }
  return (
    <>
      <div className="fdy-chat-popover-note">
        <span>{t("controls.codexPermissions")}</span>
      </div>
      <div className="fdy-chat-permission-section">{t("controls.sandbox")}</div>
      {codexSandboxModes.map((mode) => (
        <Button
          className="fdy-chat-menu-option"
          data-selected={mode === codexSandboxMode}
          key={mode}
          onClick={() => onCodexSandboxModeChange(mode)}
          variant="ghost"
        >
          <ShieldAlert size={18} />
          <span title={mode}>
            <strong>{t(`codexSandbox.${mode}`)}</strong>
            <em>{t(`codexSandboxSummary.${mode}`)}</em>
          </span>
          {mode === codexSandboxMode ? <Check size={17} /> : null}
        </Button>
      ))}
      <div className="fdy-chat-permission-section">
        {t("controls.approval")}
      </div>
      {codexApprovalPolicies.map((policy) => (
        <Button
          className="fdy-chat-menu-option"
          data-selected={policy === codexApprovalPolicy}
          key={policy}
          onClick={() => onCodexApprovalPolicyChange(policy)}
          variant="ghost"
        >
          <Hand size={18} />
          <span title={policy}>
            <strong>{t(`codexApproval.${policy}`)}</strong>
            <em>{t(`codexApprovalSummary.${policy}`)}</em>
          </span>
          {policy === codexApprovalPolicy ? <Check size={17} /> : null}
        </Button>
      ))}
    </>
  );
}
