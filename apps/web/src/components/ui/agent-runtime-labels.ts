import type {
  AgentModelOption,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import {
  claudeEffortOptions,
  codexEffortOptions,
  effortLabel,
} from "../../lib/agent-effort";
import { i18n } from "../../i18n";
import type { RuntimeKind } from "./runtime-mark";

export type ControlledRuntime = Exclude<RuntimeKind, "mock">;
export type EffectiveClaudePermission = Exclude<
  ClaudePermissionMode,
  "default"
>;

export function compactModelLabel(
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

export function labelForSpeed(value: CodexSpeed): string {
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

/** What the permissions trigger shows for the runtime's current access. */
export function describePermission(input: {
  runtime: ControlledRuntime;
  claudePermissionMode: ClaudePermissionMode;
  codexSandboxMode: CodexSandboxMode;
}) {
  const claudePermission: EffectiveClaudePermission =
    input.claudePermissionMode === "default"
      ? "acceptEdits"
      : input.claudePermissionMode;
  const claude = input.runtime === "claude";
  return {
    claudePermission,
    // The toolbar shows a short name; the full one stays in its tooltip,
    // accessible name and the open menu.
    triggerLabel: claude
      ? i18n.t(`agents:permissionShort.claude.${claudePermission}`)
      : i18n.t(`agents:permissionShort.codex.${input.codexSandboxMode}`),
    triggerDescription: i18n.t("agents:controls.permissionsTrigger", {
      label: claude
        ? labelForClaudePermission(claudePermission)
        : i18n.t(`agents:codexSandbox.${input.codexSandboxMode}`),
    }),
    danger: claude
      ? claudePermission === "bypassPermissions" ||
        claudePermission === "dontAsk"
      : input.codexSandboxMode === "danger-full-access",
  };
}

/** What the model-and-effort trigger and its panels show. */
export function describeModelAndEffort(input: {
  runtime: ControlledRuntime;
  claudeEffort: ClaudeEffort | "";
  codexReasoningEffort: CodexReasoningEffort | "";
  modelLoadFailed: boolean;
  modelLoading: boolean;
  modelOptions: AgentModelOption[];
  modelValue: string;
}) {
  const { modelOptions, modelValue } = input;
  const selectedModel =
    modelOptions.find((model) => model.id === modelValue) ??
    (modelValue ? { id: modelValue, label: modelValue } : undefined);
  const effortValue: ClaudeEffort | CodexReasoningEffort =
    input.runtime === "claude"
      ? input.claudeEffort || "high"
      : input.codexReasoningEffort || "high";
  const modelPanel = resolveModelPanelState({
    loading: input.modelLoading,
    failed: input.modelLoadFailed,
    hasOptions: modelOptions.length > 0,
  });
  const modelLabel =
    modelPanel.triggerLabel ?? compactModelLabel(selectedModel, modelValue);
  const currentEffortLabel = effortLabel(effortValue);
  return {
    modelPanel,
    /** The selected model, or the panel's state while none is selectable. */
    modelLabel,
    effortValue,
    effortLabel: currentEffortLabel,
    effortOptions:
      input.runtime === "claude" ? claudeEffortOptions() : codexEffortOptions(),
    triggerDescription: i18n.t("agents:controls.modelAndEffortTrigger", {
      model: modelLabel,
      effort: currentEffortLabel,
    }),
  };
}

export type ModelAndEffortView = ReturnType<typeof describeModelAndEffort>;
