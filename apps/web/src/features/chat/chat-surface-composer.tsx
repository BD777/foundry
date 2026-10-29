import type { ConversationComposer } from "../../components/conversation/conversation-types";
import { AgentPickerFooter } from "../../components/ui/agent-picker-footer";
import { navigateToDeviceAgents } from "../../lib/in-app-navigation";
import type { ChatSurfaceProps } from "./chat-surface-types";

/** The chat composer: agent choice, slash skills and runtime controls. */
export function chatComposer(props: ChatSurfaceProps): ConversationComposer {
  const selectedRuntime =
    props.agentOptions.find((agent) => agent.value === props.selectedAgentId)
      ?.runtime ??
    props.agentOptions[0]?.runtime ??
    "codex";
  const disabledAgentDeviceId = props.agentOptions.find(
    (agent) => agent.disabled,
  )?.deviceId;
  return {
    mode: "selectable",
    agentOptions: props.agentOptions,
    agentPickerActions: props.agentPickerActions,
    slashItems: props.slashSkills,
    agentPickerFooter: (
      <AgentPickerFooter
        deviceId={disabledAgentDeviceId}
        onManage={navigateToDeviceAgents}
      />
    ),
    agentValue: props.selectedAgentId,
    onAgentChange: props.onAgentChange,
    runtimeControls: {
      // A verifier keeps its sandbox; a message cannot change it.
      showPermissions: !props.contextCard?.status?.verification,
      selectedRuntime,
      claudeEffort: props.claudeEffort,
      claudePermissionMode: props.claudePermissionMode,
      codexApprovalPolicy: props.codexApprovalPolicy,
      codexReasoningEffort: props.codexReasoningEffort,
      codexSandboxMode: props.codexSandboxMode,
      codexSpeed: props.codexSpeed,
      modelLoadFailed: props.modelLoadFailed ?? false,
      modelLoading: props.modelLoading ?? false,
      modelOptions: props.modelOptions,
      modelValue: props.modelValue,
      onClaudeEffortChange: props.onClaudeEffortChange,
      onClaudePermissionModeChange: props.onClaudePermissionModeChange,
      onCodexApprovalPolicyChange: props.onCodexApprovalPolicyChange,
      onCodexReasoningEffortChange: props.onCodexReasoningEffortChange,
      onCodexSandboxModeChange: props.onCodexSandboxModeChange,
      onCodexSpeedChange: props.onCodexSpeedChange,
      onModelChange: props.onModelChange,
      onResetControls: props.onResetControls,
      onRetryModels: props.onRetryModels,
    },
  };
}
