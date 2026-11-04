import { Plus } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { FileInput, type FileInputProps } from "../ui/field";
import { MetaPill } from "../ui/meta-pill";
import { RuntimeMark, runtimeMeta, type RuntimeKind } from "./runtime-mark";
import { SelectMenu, type SelectMenuAction } from "../ui/select-menu";
import {
  AgentRuntimeControls,
  type AgentRuntimeControlsProps,
} from "./agent-runtime-controls";
import {
  MessageComposer,
  ComposerInput,
  ComposerFooter,
  ComposerSubmit,
  type ComposerInputProps,
  type ComposerSubmitState,
} from "../ui/message-composer";
import { cn } from "../../lib/cn";
import { Tooltip } from "../ui/tooltip";
import { ChevronDown } from "lucide-react";
import { ChoiceMenu, type ChoiceMenuOption } from "../ui/choice-menu";
import type { SlashSuggestion } from "../ui/slash-menu";
import type { PanelProps } from "../ui/panel";

/**
 * The agent pill's rules. Under 860px the pill clips to a fixed width, and
 * "flat" trades the border for a soft fill, like the chat composer's other
 * borderless controls.
 */
function agentPillClass(pillStyle: "outlined" | "flat"): string {
  return cn(
    "max-[860px]:max-w-39.5 max-[860px]:flex-[0_1_158px] max-[860px]:overflow-hidden max-[860px]:text-ellipsis max-[860px]:whitespace-nowrap",
    pillStyle === "flat" &&
      "h-6.5 min-w-0 border-0 bg-control-ghost-hover text-ink-faint",
  );
}

export interface ComposerAgentOption {
  value: string;
  label: string;
  runtime: Exclude<RuntimeKind, "mock">;
  disabled?: boolean;
  /** Short source/status line; also shown on the trigger when selected. */
  meta?: string;
  /** Full wrapping explanation for an unavailable row; never on the trigger. */
  detail?: string;
}

export interface AgentComposerProps extends PanelProps {
  input: ComposerInputProps;
  /** "/token" suggestions offered in the input (workspace-selected skills). */
  slashItems?: SlashSuggestion[];
  agentOptions?: ComposerAgentOption[];
  /** Reachable help/management content rendered at the bottom of the picker. */
  agentPickerFooter?: ReactNode;
  /**
   * Rows that act instead of selecting, after the agents: e.g. setting up a
   * connection this device does not have yet.
   */
  agentPickerActions?: SelectMenuAction[];
  agentValue?: string;
  agentLabel?: string;
  onAgentChange?: (value: string) => void;
  runtimeControls?: AgentRuntimeControlsProps;
  fixedRuntime?: { runtime: RuntimeKind; model?: string };
  /**
   * A conversation whose agent the person neither picks nor sees (the
   * assistant): no agent pill, picker or runtime controls.
   */
  hideAgent?: boolean;
  /**
   * "flat": the agent pill drops its border for a soft fill, matching the
   * borderless controls of a chat composer. Defaults to "outlined".
   */
  pillStyle?: "outlined" | "flat";
  showPermissions?: boolean;
  side?: "top" | "bottom";
  controlsDisabled?: boolean;
  fileInput?: FileInputProps & { ref?: Ref<HTMLInputElement> };
  onAttach?: () => void;
  onAction: () => void;
  actionLabel: string;
  /** What the action does now; its icon and busy state follow. */
  actionState?: ComposerSubmitState;
  /** A longer explanation shown on hover/focus; defaults to the label. */
  actionHint?: ReactNode;
  actionDisabled?: boolean;
  /**
   * Other ways to send, behind a chevron next to the action (a split
   * button): e.g. when a message enters a running turn.
   */
  actionMenu?: ComposerActionMenu;
}

export interface ComposerActionMenu {
  label: string;
  heading?: ReactNode;
  options: ChoiceMenuOption<string>[];
  onChoose: (value: string) => void;
  disabled?: boolean;
}

/** One complete composer for Chats and Issues. Feature code supplies state, not toolbar markup. */
export function AgentComposer({
  input,
  children,
  agentOptions = [],
  agentPickerFooter,
  agentPickerActions = [],
  agentValue = "",
  agentLabel,
  onAgentChange,
  runtimeControls,
  fixedRuntime,
  hideAgent = false,
  pillStyle = "outlined",
  showPermissions = true,
  side = "top",
  controlsDisabled = false,
  fileInput,
  onAttach,
  onAction,
  actionLabel,
  actionState = "send",
  actionHint,
  actionDisabled,
  actionMenu,
  slashItems,
  ...panel
}: AgentComposerProps) {
  const { t } = useTranslation("agents");
  return (
    <MessageComposer {...panel} className={panel.className}>
      {children}
      <ComposerInput {...input} slashItems={slashItems} />
      <ComposerFooter className="fdy-chat-composer-footer">
        {fileInput ? <FileInput {...fileInput} className="hidden" /> : null}
        {onAttach ? (
          <Button
            aria-label={t("composer.attachContext")}
            className="size-8.5 flex-none text-ink hover:bg-control-ghost-hover"
            onClick={onAttach}
            disabled={controlsDisabled}
            size="icon"
            variant="ghost"
          >
            <Plus size={18} />
          </Button>
        ) : null}
        {hideAgent ? null : fixedRuntime ? (
          <MetaPill
            className={cn(
              "min-w-0 max-w-[calc(100%-48px)]",
              agentPillClass(pillStyle),
            )}
            mono
            size="sm"
            tone="muted"
          >
            <RuntimeMark runtime={fixedRuntime.runtime} size="sm" />
            <span className="min-w-0 truncate">
              {runtimeMeta(fixedRuntime.runtime).label}
              {fixedRuntime.model ? ` · ${fixedRuntime.model}` : ""}
            </span>
          </MetaPill>
        ) : (agentOptions.length || agentPickerActions.length) &&
          runtimeControls &&
          onAgentChange ? (
          <SelectMenu
            actions={agentPickerActions}
            ariaLabel={agentLabel ?? t("composer.agent")}
            side={side}
            className="w-auto min-w-0 flex-initial"
            compactTrigger="auto"
            triggerClassName="max-w-70"
            footer={agentPickerFooter}
            onChange={onAgentChange}
            value={agentValue}
            disabled={controlsDisabled}
            options={agentOptions}
            renderOptionPrefix={(option) => (
              <RuntimeMark
                className="flex-none"
                runtime={
                  agentOptions.find((agent) => agent.value === option.value)
                    ?.runtime ?? runtimeControls.selectedRuntime
                }
                size="sm"
              />
            )}
            renderTriggerPrefix={() => (
              <RuntimeMark
                className="flex-none"
                runtime={runtimeControls.selectedRuntime}
                size="sm"
              />
            )}
            tone="pill"
          />
        ) : (
          <MetaPill
            className={agentPillClass(pillStyle)}
            mono
            size="sm"
            tone="muted"
          >
            {t("composer.noAgent")}
          </MetaPill>
        )}
        {runtimeControls && !fixedRuntime && !hideAgent ? (
          <AgentRuntimeControls
            {...runtimeControls}
            showPermissions={
              showPermissions && runtimeControls.showPermissions !== false
            }
            side={side}
            disabled={controlsDisabled}
          />
        ) : null}
        <span
          className="ml-auto inline-flex flex-none items-center gap-0.5"
          data-split={actionMenu ? "true" : undefined}
        >
          <Tooltip content={actionHint ?? actionLabel}>
            <ComposerSubmit
              aria-label={actionLabel}
              className="ml-0"
              state={actionState}
              disabled={actionDisabled}
              onClick={onAction}
            />
          </Tooltip>
          {actionMenu ? (
            // No tooltip: the menu's heading says what it offers, and a
            // tooltip would stay over the open menu.
            <ChoiceMenu
              disabled={actionMenu.disabled}
              heading={actionMenu.heading}
              label={actionMenu.label}
              onChoose={actionMenu.onChoose}
              options={actionMenu.options}
              side={side}
              triggerClassName="h-8.5 w-6 min-w-6 p-0 text-ink-muted hover:text-ink data-[state=open]:text-ink"
            >
              <ChevronDown size={15} />
            </ChoiceMenu>
          ) : null}
        </span>
      </ComposerFooter>
    </MessageComposer>
  );
}
