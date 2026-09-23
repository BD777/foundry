import { Plus } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "./button";
import { FileInput, type FileInputProps } from "./field";
import { MetaPill } from "./meta-pill";
import { RuntimeMark, type RuntimeKind } from "./runtime-mark";
import { SelectMenu } from "./select-menu";
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
} from "./message-composer";
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
  agentValue?: string;
  agentLabel?: string;
  onAgentChange?: (value: string) => void;
  runtimeControls?: AgentRuntimeControlsProps;
  fixedRuntime?: { runtime: RuntimeKind; model?: string };
  showPermissions?: boolean;
  side?: "top" | "bottom";
  controlsDisabled?: boolean;
  fileInput?: FileInputProps & { ref?: Ref<HTMLInputElement> };
  onAttach?: () => void;
  onAction: () => void;
  actionLabel: string;
  actionDisabled?: boolean;
  active?: boolean;
}

/** One complete composer for Chats and Issues. Feature code supplies state, not toolbar markup. */
export function AgentComposer({
  input,
  children,
  agentOptions = [],
  agentPickerFooter,
  agentValue = "",
  agentLabel = "Agent",
  onAgentChange,
  runtimeControls,
  fixedRuntime,
  showPermissions = true,
  side = "top",
  controlsDisabled = false,
  fileInput,
  onAttach,
  onAction,
  actionLabel,
  actionDisabled,
  active,
  slashItems,
  ...panel
}: AgentComposerProps) {
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
            aria-label="Attach context"
            className="fdy-chat-context-button"
            onClick={onAttach}
            disabled={controlsDisabled}
            size="icon"
            variant="ghost"
          >
            <Plus size={18} />
          </Button>
        ) : null}
        {fixedRuntime ? (
          <MetaPill
            className="fdy-chat-fixed-runtime"
            mono
            size="sm"
            tone="muted"
          >
            <RuntimeMark runtime={fixedRuntime.runtime} size="sm" />
            <span className="fdy-chat-fixed-runtime-label">
              {fixedRuntime.runtime === "claude"
                ? "Claude"
                : fixedRuntime.runtime === "codex"
                  ? "Codex"
                  : "Mock"}
              {fixedRuntime.model ? ` · ${fixedRuntime.model}` : ""}
            </span>
          </MetaPill>
        ) : agentOptions.length && runtimeControls && onAgentChange ? (
          <SelectMenu
            ariaLabel={agentLabel}
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
            No agent
          </MetaPill>
        )}
        {runtimeControls && !fixedRuntime ? (
          <AgentRuntimeControls
            {...runtimeControls}
            showPermissions={showPermissions}
            side={side}
            disabled={controlsDisabled}
          />
        ) : null}
        <ComposerSubmit
          aria-label={actionLabel}
          className="fdy-chat-send-button"
          active={active}
          disabled={actionDisabled}
          onClick={onAction}
        />
      </ComposerFooter>
    </MessageComposer>
  );
}
