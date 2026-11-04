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
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { DropdownMenuPanel } from "../ui/row-menu-parts";
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

/** The two composer triggers: a quiet pill that shrinks before Send does. */
const triggerClass =
  "h-8.5 items-center gap-1.5 rounded-full bg-transparent px-2 py-0 text-xs font-[560] leading-none text-ink hover:bg-control-ghost-hover aria-expanded:bg-control-ghost-hover";

/**
 * The menus' surface. Radix positions its wrapper, so the panel itself is
 * only relative and bounded by the room the menu was given.
 */
const popoverClass =
  "relative z-50 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto rounded-xl bg-panel text-ink shadow-floating";

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
      <div className="min-w-1 flex-auto @max-[660px]/fdy-composer:min-w-0" />
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
    <div className="relative min-w-0 flex-initial">
      <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={permission.triggerDescription}
            title={permission.triggerDescription}
            disabled={controls.disabled ?? false}
            className={cn(
              triggerClass,
              "fdy-chat-access-trigger min-w-0 data-[mode=danger]:text-error-text",
              "@max-[580px]/fdy-composer:flex-none @max-[580px]/fdy-composer:gap-0 @max-[580px]/fdy-composer:px-2.25",
            )}
            data-mode={permission.danger ? "danger" : "normal"}
            variant="ghost"
          >
            <ShieldAlert className="flex-none" size={16} />
            <span className="min-w-0 truncate @max-[580px]/fdy-composer:hidden">
              {permission.triggerLabel}
            </span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenuPanel
            aria-label={t("controls.permissions")}
            side={controls.side ?? "top"}
            sideOffset={12}
            align="start"
            collisionPadding={12}
            className={cn(
              popoverClass,
              "w-[min(480px,calc(100vw-48px))] p-3.5",
            )}
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
          </DropdownMenuPanel>
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
    <div className="relative min-w-0 flex-initial">
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
            className={cn(
              triggerClass,
              "fdy-chat-settings-trigger min-w-0 justify-center whitespace-nowrap",
              "@max-[660px]/fdy-composer:justify-start @max-[400px]/fdy-composer:px-2.25",
            )}
            variant="ghost"
          >
            <SlidersHorizontal
              aria-hidden="true"
              className="flex-none"
              size={15}
            />
            {selectedRuntime === "codex" && codexSpeed === "fast" ? (
              <Zap size={15} />
            ) : null}
            <span className="min-w-0 truncate @max-[400px]/fdy-composer:hidden">
              {view.modelLabel}
            </span>
            <em className="font-medium text-ink-faint not-italic @max-[580px]/fdy-composer:hidden">
              {view.effortLabel}
            </em>
            <ChevronDown size={15} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenuPanel
            aria-label={t("controls.modelAndEffort")}
            side={controls.side ?? "top"}
            sideOffset={12}
            align="end"
            collisionPadding={12}
            className={cn(
              popoverClass,
              "flex min-w-75 max-w-[calc(100vw-60px)] p-2.5",
              "max-[860px]:max-w-[calc(100vw-24px)] max-[680px]:min-w-0 max-[680px]:flex-wrap",
            )}
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
          </DropdownMenuPanel>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
