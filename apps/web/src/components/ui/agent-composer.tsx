import { Plus } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { FileInput, type FileInputProps } from "./field";
import { MetaPill } from "./meta-pill";
import { RuntimeMark, runtimeMeta, type RuntimeKind } from "./runtime-mark";
import { SelectMenu, type SelectMenuAction } from "./select-menu";
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
} from "./message-composer";
import { Tooltip } from "./tooltip";
import { ChevronDown } from "lucide-react";
import { ChoiceMenu, type ChoiceMenuOption } from "./choice-menu";
import type { SlashSuggestion } from "./slash-menu";
import type { PanelProps } from "./panel";

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
    <MessageComposer {...panel}>
      {children}
      <ComposerInput {...input} slashItems={slashItems} />
      <ComposerFooter className="fdy-chat-composer-footer">
        {fileInput ? (
          <FileInput {...fileInput} className="fdy-chat-file-input" />
        ) : null}
        {onAttach ? (
          <Button
            aria-label={t("composer.attachContext")}
            className="fdy-chat-context-button"
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
            className="fdy-chat-fixed-runtime"
            mono
            size="sm"
            tone="muted"
          >
            <RuntimeMark runtime={fixedRuntime.runtime} size="sm" />
            <span className="fdy-chat-fixed-runtime-label">
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
            className="fdy-chat-agent-select"
            footer={agentPickerFooter}
            onChange={onAgentChange}
            value={agentValue}
            disabled={controlsDisabled}
            options={agentOptions}
            renderOptionPrefix={(option) => (
              <RuntimeMark
                runtime={
                  agentOptions.find((agent) => agent.value === option.value)
                    ?.runtime ?? runtimeControls.selectedRuntime
                }
                size="sm"
              />
            )}
            renderTriggerPrefix={() => (
              <RuntimeMark
                runtime={runtimeControls.selectedRuntime}
                size="sm"
              />
            )}
            tone="pill"
          />
        ) : (
          <MetaPill mono size="sm" tone="muted">
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
          className="fdy-composer-action"
          data-split={actionMenu ? "true" : undefined}
        >
          <Tooltip content={actionHint ?? actionLabel}>
            <ComposerSubmit
              aria-label={actionLabel}
              className="fdy-chat-send-button"
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
              triggerClassName="fdy-composer-action-chevron"
            >
              <ChevronDown size={15} />
            </ChoiceMenu>
          ) : null}
        </span>
      </ComposerFooter>
    </MessageComposer>
  );
}
