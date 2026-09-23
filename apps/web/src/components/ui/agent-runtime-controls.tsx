import {
  Check,
  ChevronDown,
  ChevronRight,
  Hand,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type {
  AgentModelOption,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
} from "@foundry/protocol";
import { Button } from "./button";
import {
  claudeEffortOptions,
  codexEffortOptions,
} from "../../lib/agent-effort";
import type { RuntimeKind } from "./runtime-mark";

type SettingsPanel = "main" | "model" | "effort" | "speed";

const claudePermissionOptions: Array<{
  label: string;
  summary: string;
  value: Exclude<ClaudePermissionMode, "default">;
}> = [
  {
    label: "Accept edits",
    summary: "允许编辑，敏感操作仍按 Claude Code 规则处理",
    value: "acceptEdits",
  },
  { label: "Auto", summary: "由 Claude Code 自动选择权限行为", value: "auto" },
  {
    label: "Bypass permissions",
    summary: "跳过 Claude Code 权限确认",
    value: "bypassPermissions",
  },
  { label: "Don't ask", summary: "不再询问权限确认", value: "dontAsk" },
  { label: "Plan", summary: "先规划，不直接执行修改", value: "plan" },
];

const codexSandboxOptions: Array<{
  label: string;
  summary: string;
  value: CodexSandboxMode;
}> = [
  { label: "read-only", summary: "只读访问", value: "read-only" },
  {
    label: "workspace-write",
    summary: "可写当前 workspace",
    value: "workspace-write",
  },
  {
    label: "danger-full-access",
    summary: "完整本机访问",
    value: "danger-full-access",
  },
];

const codexApprovalOptions: Array<{
  label: string;
  summary: string;
  value: CodexApprovalPolicy;
}> = [
  { label: "untrusted", summary: "不可信模式", value: "untrusted" },
  { label: "on-request", summary: "按请求确认", value: "on-request" },
  { label: "on-failure", summary: "失败后请求权限", value: "on-failure" },
  { label: "never", summary: "不请求确认", value: "never" },
];

function compactModelLabel(
  model: AgentModelOption | undefined,
  value: string,
): string {
  const label = model?.label ?? value;
  if (!label) {
    return "Model";
  }
  return label
    .replace(/^gpt-/i, "")
    .replace(/^claude-/i, "")
    .replace(/-/g, " ")
    .replace(/\bcodex\b/gi, "Codex")
    .replace(/\bmini\b/gi, "Mini")
    .replace(/\bsol\b/gi, "Sol")
    .replace(/\bterra\b/gi, "Terra")
    .replace(/\bluna\b/gi, "Luna");
}

function labelForEffort(
  runtime: Exclude<RuntimeKind, "mock">,
  value: ClaudeEffort | CodexReasoningEffort,
): string {
  const options =
    runtime === "claude" ? claudeEffortOptions : codexEffortOptions;
  return options.find((option) => option.value === value)?.summary ?? value;
}

function labelForSpeed(value: CodexSpeed): string {
  return value === "fast" ? "快速" : "标准";
}

function labelForClaudePermission(value: ClaudePermissionMode): string {
  const normalized = value === "default" ? "acceptEdits" : value;
  return (
    claudePermissionOptions.find((option) => option.value === normalized)
      ?.label ?? normalized
  );
}

export interface ModelPanelState {
  /** Label forced onto the trigger ("Loading models" / "Models unavailable"). */
  triggerLabel?: string;
  /** Whether the configured/discovered model list is selectable. */
  showOptions: boolean;
  /** Copy for the empty panel when showOptions is false. */
  emptyLabel?: string;
  /** The native metadata refresh failed; surfaced with a retry action. */
  refreshFailed: boolean;
}

/**
 * A failed model-directory refresh must not flatten a profile's already
 * configured models into "unavailable": discovery only augments the curated
 * list, so the failure is a recoverable note whenever models remain selectable.
 */
export function resolveModelPanelState(input: {
  loading: boolean;
  failed: boolean;
  hasOptions: boolean;
}): ModelPanelState {
  if (input.loading) {
    return {
      triggerLabel: "Loading models",
      showOptions: false,
      refreshFailed: false,
    };
  }
  if (input.failed) {
    if (input.hasOptions) {
      return { showOptions: true, refreshFailed: true };
    }
    return {
      triggerLabel: "Models unavailable",
      showOptions: false,
      emptyLabel: "Models unavailable",
      refreshFailed: true,
    };
  }
  if (!input.hasOptions) {
    return {
      triggerLabel: "No models",
      showOptions: false,
      emptyLabel: "No models",
      refreshFailed: false,
    };
  }
  return { showOptions: true, refreshFailed: false };
}

export interface AgentRuntimeControlsProps {
  showPermissions?: boolean;
  disabled?: boolean;
  side?: "top" | "bottom";
  claudeEffort: ClaudeEffort | "";
  claudePermissionMode: ClaudePermissionMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexReasoningEffort: CodexReasoningEffort | "";
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  modelLoadFailed: boolean;
  modelLoading: boolean;
  modelOptions: AgentModelOption[];
  modelValue: string;
  onClaudeEffortChange: (value: ClaudeEffort | "") => void;
  onClaudePermissionModeChange: (value: ClaudePermissionMode) => void;
  onCodexApprovalPolicyChange: (value: CodexApprovalPolicy) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort | "") => void;
  onCodexSandboxModeChange: (value: CodexSandboxMode) => void;
  onCodexSpeedChange: (value: CodexSpeed) => void;
  onMenuOpenChange?: (open: boolean) => void;
  onModelChange: (value: string) => void;
  onResetControls: () => void;
  /** Re-runs the native metadata discovery; keeps the menu open while loading. */
  onRetryModels?: () => void;
  selectedRuntime: Exclude<RuntimeKind, "mock">;
}

export function AgentRuntimeControls({
  showPermissions = true,
  disabled = false,
  side = "top",
  claudeEffort,
  claudePermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
  codexSpeed,
  modelLoadFailed,
  modelLoading,
  modelOptions,
  modelValue,
  onClaudeEffortChange,
  onClaudePermissionModeChange,
  onCodexApprovalPolicyChange,
  onCodexReasoningEffortChange,
  onCodexSandboxModeChange,
  onCodexSpeedChange,
  onMenuOpenChange,
  onModelChange,
  onResetControls,
  onRetryModels,
  selectedRuntime,
}: AgentRuntimeControlsProps) {
  const [accessOpen, setAccessOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>("main");

  const selectedModel =
    modelOptions.find((model) => model.id === modelValue) ??
    (modelValue ? { id: modelValue, label: modelValue } : undefined);
  const modelLabel = compactModelLabel(selectedModel, modelValue);
  const effectiveClaudeEffort: ClaudeEffort = claudeEffort || "high";
  const effectiveCodexEffort: CodexReasoningEffort =
    codexReasoningEffort || "high";
  const effortValue =
    selectedRuntime === "claude" ? effectiveClaudeEffort : effectiveCodexEffort;
  const effortLabel = labelForEffort(selectedRuntime, effortValue);
  const effectiveClaudePermission: Exclude<ClaudePermissionMode, "default"> =
    claudePermissionMode === "default" ? "acceptEdits" : claudePermissionMode;
  const permissionTriggerLabel =
    selectedRuntime === "claude"
      ? labelForClaudePermission(effectiveClaudePermission)
      : codexSandboxMode;
  const permissionTriggerDescription = `Permissions: ${permissionTriggerLabel}`;
  const permissionDanger =
    selectedRuntime === "claude"
      ? effectiveClaudePermission === "bypassPermissions" ||
        effectiveClaudePermission === "dontAsk"
      : codexSandboxMode === "danger-full-access";
  const modelPanel = resolveModelPanelState({
    loading: modelLoading,
    failed: modelLoadFailed,
    hasOptions: modelOptions.length > 0,
  });
  const modelStatusLabel = modelPanel.triggerLabel;
  const modelTriggerDescription = `Model and effort: ${modelStatusLabel ?? modelLabel} · ${effortLabel}`;
  const effortOptions =
    selectedRuntime === "claude" ? claudeEffortOptions : codexEffortOptions;

  const applyClaudePermission = (
    value: Exclude<ClaudePermissionMode, "default">,
  ): void => {
    onClaudePermissionModeChange(value);
    setAccessOpen(false);
  };
  const applyEffort = (value: ClaudeEffort | CodexReasoningEffort): void => {
    if (selectedRuntime === "claude") {
      onClaudeEffortChange(value as ClaudeEffort);
    } else {
      onCodexReasoningEffortChange(value as CodexReasoningEffort);
    }
    setSettingsOpen(false);
    setSettingsPanel("main");
  };
  const openSettingsPanel = (panel: SettingsPanel): void => {
    setSettingsPanel(panel);
    setSettingsOpen(true);
  };

  useEffect(() => {
    onMenuOpenChange?.(accessOpen || settingsOpen);
  }, [accessOpen, onMenuOpenChange, settingsOpen]);

  useEffect(() => {
    if (!showPermissions || disabled) setAccessOpen(false);
    if (disabled) setSettingsOpen(false);
  }, [disabled, showPermissions]);

  return (
    <>
      {showPermissions ? (
        <div className="fdy-chat-access-menu">
          <DropdownMenu.Root
            modal={false}
            open={accessOpen}
            onOpenChange={(open) => {
              setAccessOpen(open);
              if (open) setSettingsOpen(false);
            }}
          >
            <DropdownMenu.Trigger asChild>
              <Button
                aria-label={permissionTriggerDescription}
                title={permissionTriggerDescription}
                disabled={disabled}
                className="fdy-chat-access-trigger"
                data-mode={permissionDanger ? "danger" : "normal"}
                variant="ghost"
              >
                <ShieldAlert size={16} />
                <span className="fdy-chat-access-label">
                  {permissionTriggerLabel}
                </span>
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                aria-label="Permissions"
                side={side}
                sideOffset={12}
                align="start"
                collisionPadding={12}
                className="fdy-chat-popover fdy-chat-access-popover fdy-runtime-popover"
              >
                {selectedRuntime === "claude" ? (
                  <>
                    <div className="fdy-chat-popover-note">
                      <span>Claude Code permission</span>
                    </div>
                    {claudePermissionOptions.map((option) => (
                      <Button
                        className="fdy-chat-menu-option"
                        data-selected={
                          option.value === effectiveClaudePermission
                        }
                        key={option.value}
                        onClick={() => applyClaudePermission(option.value)}
                        variant="ghost"
                      >
                        <Hand size={18} />
                        <span>
                          <strong>{option.label}</strong>
                          <em>{option.summary}</em>
                        </span>
                        {option.value === effectiveClaudePermission ? (
                          <Check size={17} />
                        ) : null}
                      </Button>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="fdy-chat-popover-note">
                      <span>Codex permissions</span>
                    </div>
                    <div className="fdy-chat-permission-section">Sandbox</div>
                    {codexSandboxOptions.map((option) => (
                      <Button
                        className="fdy-chat-menu-option"
                        data-selected={option.value === codexSandboxMode}
                        key={option.value}
                        onClick={() => onCodexSandboxModeChange(option.value)}
                        variant="ghost"
                      >
                        <ShieldAlert size={18} />
                        <span>
                          <strong>{option.label}</strong>
                          <em>{option.summary}</em>
                        </span>
                        {option.value === codexSandboxMode ? (
                          <Check size={17} />
                        ) : null}
                      </Button>
                    ))}
                    <div className="fdy-chat-permission-section">Approval</div>
                    {codexApprovalOptions.map((option) => (
                      <Button
                        className="fdy-chat-menu-option"
                        data-selected={option.value === codexApprovalPolicy}
                        key={option.value}
                        onClick={() =>
                          onCodexApprovalPolicyChange(option.value)
                        }
                        variant="ghost"
                      >
                        <Hand size={18} />
                        <span>
                          <strong>{option.label}</strong>
                          <em>{option.summary}</em>
                        </span>
                        {option.value === codexApprovalPolicy ? (
                          <Check size={17} />
                        ) : null}
                      </Button>
                    ))}
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
      <div className="fdy-chat-toolbar-spacer" />
      <div className="fdy-chat-settings-menu">
        <DropdownMenu.Root
          modal={false}
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            setSettingsPanel("main");
            if (open) setAccessOpen(false);
          }}
        >
          <DropdownMenu.Trigger asChild>
            <Button
              aria-label={modelTriggerDescription}
              title={modelTriggerDescription}
              disabled={disabled}
              className="fdy-chat-settings-trigger"
              variant="ghost"
            >
              <SlidersHorizontal
                aria-hidden="true"
                className="fdy-chat-settings-icon"
                size={15}
              />
              {selectedRuntime === "codex" && codexSpeed === "fast" ? (
                <Zap size={15} />
              ) : null}
              <span className="fdy-chat-settings-model">
                {modelStatusLabel ?? modelLabel}
              </span>
              <em className="fdy-chat-settings-effort">{effortLabel}</em>
              <ChevronDown size={15} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              aria-label="Model and effort"
              side={side}
              sideOffset={12}
              align="end"
              collisionPadding={12}
              className="fdy-chat-popover fdy-chat-settings-popover fdy-runtime-popover"
              data-panel={settingsPanel}
            >
              <div className="fdy-chat-settings-main">
                <Button
                  className="fdy-chat-menu-row"
                  onClick={() => openSettingsPanel("model")}
                  variant="ghost"
                >
                  <strong>模型</strong>
                  <span>{modelStatusLabel ?? modelLabel}</span>
                  <ChevronRight size={17} />
                </Button>
                <Button
                  className="fdy-chat-menu-row"
                  onClick={() => openSettingsPanel("effort")}
                  variant="ghost"
                >
                  <strong>推理强度</strong>
                  <span>{effortLabel}</span>
                  <ChevronRight size={17} />
                </Button>
                {selectedRuntime === "codex" ? (
                  <Button
                    className="fdy-chat-menu-row"
                    onClick={() => openSettingsPanel("speed")}
                    variant="ghost"
                  >
                    <strong>速度</strong>
                    <span>{labelForSpeed(codexSpeed)}</span>
                    <ChevronRight size={17} />
                  </Button>
                ) : null}
                <div className="fdy-chat-menu-separator" />
                <Button
                  className="fdy-chat-menu-row fdy-chat-menu-reset"
                  onClick={() => {
                    onResetControls();
                    setSettingsOpen(false);
                    setSettingsPanel("main");
                  }}
                  variant="ghost"
                >
                  <strong>恢复 Profile 配置</strong>
                  <RotateCcw size={17} />
                </Button>
              </div>
              <div className="fdy-chat-settings-submenu">
                {settingsPanel === "model" ? (
                  <>
                    <div className="fdy-chat-submenu-title">模型</div>
                    {modelPanel.refreshFailed ? (
                      <div className="fdy-chat-model-refresh">
                        <span>
                          模型目录刷新失败
                          {modelPanel.showOptions
                            ? "，已保留 Profile 配置模型"
                            : ""}
                        </span>
                        {onRetryModels ? (
                          <Button
                            className="fdy-chat-model-refresh-button"
                            disabled={modelLoading}
                            onClick={onRetryModels}
                            variant="ghost"
                          >
                            <RotateCcw size={14} />
                            重试刷新
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {modelPanel.showOptions ? (
                      modelOptions.map((model) => (
                        <Button
                          className="fdy-chat-submenu-option"
                          data-selected={model.id === modelValue}
                          key={model.id}
                          onClick={() => {
                            onModelChange(model.id);
                            setSettingsOpen(false);
                            setSettingsPanel("main");
                          }}
                          variant="ghost"
                        >
                          <span>{compactModelLabel(model, model.id)}</span>
                          {model.id === modelValue ? <Check size={18} /> : null}
                        </Button>
                      ))
                    ) : (
                      <div className="fdy-chat-submenu-empty">
                        {modelPanel.emptyLabel}
                      </div>
                    )}
                  </>
                ) : null}
                {settingsPanel === "effort" ? (
                  <>
                    <div className="fdy-chat-submenu-title">推理强度</div>
                    {effortOptions.map((option) => (
                      <Button
                        className="fdy-chat-submenu-option"
                        data-selected={option.value === effortValue}
                        key={option.value}
                        onClick={() => applyEffort(option.value)}
                        variant="ghost"
                      >
                        <span>{option.summary}</span>
                        {option.value === effortValue ? (
                          <Check size={18} />
                        ) : null}
                      </Button>
                    ))}
                  </>
                ) : null}
                {settingsPanel === "speed" ? (
                  <>
                    <div className="fdy-chat-submenu-title">速度</div>
                    <Button
                      className="fdy-chat-submenu-option fdy-chat-submenu-option-stacked"
                      data-selected={codexSpeed === "standard"}
                      onClick={() => {
                        onCodexSpeedChange("standard");
                        setSettingsOpen(false);
                        setSettingsPanel("main");
                      }}
                      variant="ghost"
                    >
                      <span>
                        <strong>标准</strong>
                        <em>常规速度</em>
                      </span>
                      {codexSpeed === "standard" ? <Check size={18} /> : null}
                    </Button>
                    <Button
                      className="fdy-chat-submenu-option fdy-chat-submenu-option-stacked"
                      data-selected={codexSpeed === "fast"}
                      onClick={() => {
                        onCodexSpeedChange("fast");
                        setSettingsOpen(false);
                        setSettingsPanel("main");
                      }}
                      variant="ghost"
                    >
                      <span>
                        <strong>快速</strong>
                        <em>1.5 倍速度，用量更多</em>
                      </span>
                      {codexSpeed === "fast" ? <Check size={18} /> : null}
                    </Button>
                  </>
                ) : null}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </>
  );
}
