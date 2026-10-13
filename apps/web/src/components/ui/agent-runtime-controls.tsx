import { ChevronDown, ShieldAlert, SlidersHorizontal, Zap } from "lucide-react";
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
import { AgentAccessOptions } from "./agent-runtime-access-options";
import {
  describeModelAndEffort,
  describePermission,
  type ControlledRuntime,
} from "./agent-runtime-labels";
import {
  AgentSettingsPanels,
  type SettingsPanel,
} from "./agent-runtime-settings-panels";

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
  selectedRuntime: ControlledRuntime;
}

export function AgentRuntimeControls(props: AgentRuntimeControlsProps) {
  const { showPermissions = true, disabled = false, onMenuOpenChange } = props;
  const [accessOpen, setAccessOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <AccessMenu
          controls={props}
          open={accessOpen}
          onOpenChange={(open) => {
            setAccessOpen(open);
            if (open) setSettingsOpen(false);
          }}
        />
      ) : null}
      <div className="fdy-chat-toolbar-spacer" />
      <SettingsMenu
        controls={props}
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (open) setAccessOpen(false);
        }}
      />
    </>
  );
}

interface MenuProps {
  controls: AgentRuntimeControlsProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The permissions menu: the runtime's access, sandbox and approval. */
function AccessMenu({ controls, open, onOpenChange }: MenuProps) {
  const { t } = useTranslation("agents");
  const permission = describePermission({
    runtime: controls.selectedRuntime,
    claudePermissionMode: controls.claudePermissionMode,
    codexSandboxMode: controls.codexSandboxMode,
  });
  return (
    <div className="fdy-chat-access-menu">
      <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={permission.triggerDescription}
            title={permission.triggerDescription}
            disabled={controls.disabled ?? false}
            className="fdy-chat-access-trigger"
            data-mode={permission.danger ? "danger" : "normal"}
            variant="ghost"
          >
            <ShieldAlert size={16} />
            <span className="fdy-chat-access-label">
              {permission.triggerLabel}
            </span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={t("controls.permissions")}
            side={controls.side ?? "top"}
            sideOffset={12}
            align="start"
            collisionPadding={12}
            className="fdy-chat-popover fdy-chat-access-popover fdy-runtime-popover"
          >
            <AgentAccessOptions
              claudePermission={permission.claudePermission}
              codexApprovalPolicy={controls.codexApprovalPolicy}
              codexSandboxMode={controls.codexSandboxMode}
              onClaudePermissionChange={(value) => {
                controls.onClaudePermissionModeChange(value);
                onOpenChange(false);
              }}
              onCodexApprovalPolicyChange={controls.onCodexApprovalPolicyChange}
              onCodexSandboxModeChange={controls.onCodexSandboxModeChange}
              selectedRuntime={controls.selectedRuntime}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** The model-and-effort menu, with the panel it shows. */
function SettingsMenu({ controls, open, onOpenChange }: MenuProps) {
  const { t } = useTranslation("agents");
  const [panel, setPanel] = useState<SettingsPanel>("main");
  const { codexSpeed, selectedRuntime } = controls;
  const view = describeModelAndEffort({
    runtime: selectedRuntime,
    claudeEffort: controls.claudeEffort,
    codexReasoningEffort: controls.codexReasoningEffort,
    modelLoadFailed: controls.modelLoadFailed,
    modelLoading: controls.modelLoading,
    modelOptions: controls.modelOptions,
    modelValue: controls.modelValue,
  });
  const applyEffort = (value: ClaudeEffort | CodexReasoningEffort): void => {
    if (selectedRuntime === "claude") {
      controls.onClaudeEffortChange(value as ClaudeEffort);
    } else {
      controls.onCodexReasoningEffortChange(value as CodexReasoningEffort);
    }
  };
  return (
    <div className="fdy-chat-settings-menu">
      <DropdownMenu.Root
        modal={false}
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          setPanel("main");
        }}
      >
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={view.triggerDescription}
            title={view.triggerDescription}
            disabled={controls.disabled ?? false}
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
            <span className="fdy-chat-settings-model">{view.modelLabel}</span>
            <em className="fdy-chat-settings-effort">{view.effortLabel}</em>
            <ChevronDown size={15} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={t("controls.modelAndEffort")}
            side={controls.side ?? "top"}
            sideOffset={12}
            align="end"
            collisionPadding={12}
            className="fdy-chat-popover fdy-chat-settings-popover fdy-runtime-popover"
            data-panel={panel}
          >
            <AgentSettingsPanels
              codexSpeed={codexSpeed}
              modelLoading={controls.modelLoading}
              modelOptions={controls.modelOptions}
              modelValue={controls.modelValue}
              onCodexSpeedChange={controls.onCodexSpeedChange}
              onDone={() => {
                onOpenChange(false);
                setPanel("main");
              }}
              onEffortChange={applyEffort}
              onModelChange={controls.onModelChange}
              onOpenPanel={(next) => {
                setPanel(next);
                onOpenChange(true);
              }}
              onResetControls={controls.onResetControls}
              onRetryModels={controls.onRetryModels}
              panel={panel}
              selectedRuntime={selectedRuntime}
              view={view}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
