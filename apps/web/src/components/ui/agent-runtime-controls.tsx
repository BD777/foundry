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
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import {
  claudeEffortOptions,
  codexEffortOptions,
  effortLabel,
} from "../../lib/agent-effort";
import { i18n } from "../../i18n";
import type { RuntimeKind } from "./runtime-mark";

type SettingsPanel = "main" | "model" | "effort" | "speed";

const claudePermissionModes: Exclude<ClaudePermissionMode, "default">[] = [
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

function compactModelLabel(
  model: AgentModelOption | undefined,
  value: string,
): string {
  const label = model?.label ?? value;
  if (!label) {
    return i18n.t("agents:controls.model");
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

function labelForSpeed(value: CodexSpeed): string {
  return i18n.t(`agents:codexSpeed.${value}`);
}

function labelForClaudePermission(value: ClaudePermissionMode): string {
  const normalized = value === "default" ? "acceptEdits" : value;
  return i18n.t(`agents:claudePermission.${normalized}`);
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
      triggerLabel: i18n.t("agents:controls.loadingModels"),
      showOptions: false,
      refreshFailed: false,
    };
  }
  if (input.failed) {
    if (input.hasOptions) {
      return { showOptions: true, refreshFailed: true };
    }
    return {
      triggerLabel: i18n.t("agents:controls.modelsUnavailable"),
      showOptions: false,
      emptyLabel: i18n.t("agents:controls.modelsUnavailable"),
      refreshFailed: true,
    };
  }
  if (!input.hasOptions) {
    return {
      triggerLabel: i18n.t("agents:controls.noModels"),
      showOptions: false,
      emptyLabel: i18n.t("agents:controls.noModels"),
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
  const { t } = useTranslation("agents");
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
  const currentEffortLabel = effortLabel(effortValue);
  const effectiveClaudePermission: Exclude<ClaudePermissionMode, "default"> =
    claudePermissionMode === "default" ? "acceptEdits" : claudePermissionMode;
  const permissionTriggerLabel =
    selectedRuntime === "claude"
      ? labelForClaudePermission(effectiveClaudePermission)
      : codexSandboxMode;
  const permissionTriggerDescription = t("controls.permissionsTrigger", {
    label: permissionTriggerLabel,
  });
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
  const modelTriggerDescription = t("controls.modelAndEffortTrigger", {
    model: modelStatusLabel ?? modelLabel,
    effort: currentEffortLabel,
  });
  const effortOptions =
    selectedRuntime === "claude" ? claudeEffortOptions() : codexEffortOptions();

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
                aria-label={t("controls.permissions")}
                side={side}
                sideOffset={12}
                align="start"
                collisionPadding={12}
                className="fdy-chat-popover fdy-chat-access-popover fdy-runtime-popover"
              >
                {selectedRuntime === "claude" ? (
                  <>
                    <div className="fdy-chat-popover-note">
                      <span>{t("controls.claudePermission")}</span>
                    </div>
                    {claudePermissionModes.map((mode) => (
                      <Button
                        className="fdy-chat-menu-option"
                        data-selected={mode === effectiveClaudePermission}
                        key={mode}
                        onClick={() => applyClaudePermission(mode)}
                        variant="ghost"
                      >
                        <Hand size={18} />
                        <span>
                          <strong>{t(`claudePermission.${mode}`)}</strong>
                          <em>{t(`claudePermissionSummary.${mode}`)}</em>
                        </span>
                        {mode === effectiveClaudePermission ? (
                          <Check size={17} />
                        ) : null}
                      </Button>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="fdy-chat-popover-note">
                      <span>{t("controls.codexPermissions")}</span>
                    </div>
                    <div className="fdy-chat-permission-section">
                      {t("controls.sandbox")}
                    </div>
                    {codexSandboxModes.map((mode) => (
                      <Button
                        className="fdy-chat-menu-option"
                        data-selected={mode === codexSandboxMode}
                        key={mode}
                        onClick={() => onCodexSandboxModeChange(mode)}
                        variant="ghost"
                      >
                        <ShieldAlert size={18} />
                        <span>
                          <strong>{mode}</strong>
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
                        <span>
                          <strong>{policy}</strong>
                          <em>{t(`codexApprovalSummary.${policy}`)}</em>
                        </span>
                        {policy === codexApprovalPolicy ? (
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
              <em className="fdy-chat-settings-effort">{currentEffortLabel}</em>
              <ChevronDown size={15} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              aria-label={t("controls.modelAndEffort")}
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
                  <strong>{t("controls.model")}</strong>
                  <span>{modelStatusLabel ?? modelLabel}</span>
                  <ChevronRight size={17} />
                </Button>
                <Button
                  className="fdy-chat-menu-row"
                  onClick={() => openSettingsPanel("effort")}
                  variant="ghost"
                >
                  <strong>{t("controls.effort")}</strong>
                  <span>{currentEffortLabel}</span>
                  <ChevronRight size={17} />
                </Button>
                {selectedRuntime === "codex" ? (
                  <Button
                    className="fdy-chat-menu-row"
                    onClick={() => openSettingsPanel("speed")}
                    variant="ghost"
                  >
                    <strong>{t("controls.speed")}</strong>
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
                  <strong>{t("controls.resetToProfile")}</strong>
                  <RotateCcw size={17} />
                </Button>
              </div>
              <div className="fdy-chat-settings-submenu">
                {settingsPanel === "model" ? (
                  <>
                    <div className="fdy-chat-submenu-title">
                      {t("controls.model")}
                    </div>
                    {modelPanel.refreshFailed ? (
                      <div className="fdy-chat-model-refresh">
                        <span>
                          {modelPanel.showOptions
                            ? t("controls.modelRefreshFailedKept")
                            : t("controls.modelRefreshFailed")}
                        </span>
                        {onRetryModels ? (
                          <Button
                            className="fdy-chat-model-refresh-button"
                            disabled={modelLoading}
                            onClick={onRetryModels}
                            variant="ghost"
                          >
                            <RotateCcw size={14} />
                            {t("controls.retryRefresh")}
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
                    <div className="fdy-chat-submenu-title">
                      {t("controls.effort")}
                    </div>
                    {effortOptions.map((option) => (
                      <Button
                        className="fdy-chat-submenu-option"
                        data-selected={option.value === effortValue}
                        key={option.value}
                        onClick={() => applyEffort(option.value)}
                        variant="ghost"
                      >
                        <span>{option.label}</span>
                        {option.value === effortValue ? (
                          <Check size={18} />
                        ) : null}
                      </Button>
                    ))}
                  </>
                ) : null}
                {settingsPanel === "speed" ? (
                  <>
                    <div className="fdy-chat-submenu-title">
                      {t("controls.speed")}
                    </div>
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
                        <strong>{t("codexSpeed.standard")}</strong>
                        <em>{t("codexSpeedSummary.standard")}</em>
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
                        <strong>{t("codexSpeed.fast")}</strong>
                        <em>{t("codexSpeedSummary.fast")}</em>
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
