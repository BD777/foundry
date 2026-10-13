import { Check, ChevronRight, RotateCcw } from "lucide-react";
import type {
  AgentModelOption,
  ClaudeEffort,
  CodexReasoningEffort,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import {
  compactModelLabel,
  labelForSpeed,
  type ControlledRuntime,
  type ModelAndEffortView,
} from "./agent-runtime-labels";

export type SettingsPanel = "main" | "model" | "effort" | "speed";

const codexSpeeds: CodexSpeed[] = ["standard", "fast"];

/**
 * The model-and-effort menu: its main rows and the submenu they open. Every
 * choice is applied, then `onDone` closes the menu.
 */
export function AgentSettingsPanels({
  codexSpeed,
  modelLoading,
  modelOptions,
  modelValue,
  onCodexSpeedChange,
  onDone,
  onEffortChange,
  onModelChange,
  onOpenPanel,
  onResetControls,
  onRetryModels,
  panel,
  selectedRuntime,
  view,
}: {
  codexSpeed: CodexSpeed;
  modelLoading: boolean;
  modelOptions: AgentModelOption[];
  modelValue: string;
  onCodexSpeedChange: (value: CodexSpeed) => void;
  onDone: () => void;
  onEffortChange: (value: ClaudeEffort | CodexReasoningEffort) => void;
  onModelChange: (value: string) => void;
  onOpenPanel: (panel: SettingsPanel) => void;
  onResetControls: () => void;
  onRetryModels?: () => void;
  panel: SettingsPanel;
  selectedRuntime: ControlledRuntime;
  view: ModelAndEffortView;
}) {
  const { t } = useTranslation("agents");
  const choose = (apply: () => void) => () => {
    apply();
    onDone();
  };
  return (
    <>
      <div className="fdy-chat-settings-main">
        <MainRow
          label={t("controls.model")}
          onClick={() => onOpenPanel("model")}
          value={view.modelLabel}
        />
        <MainRow
          label={t("controls.effort")}
          onClick={() => onOpenPanel("effort")}
          value={view.effortLabel}
        />
        {selectedRuntime === "codex" ? (
          <MainRow
            label={t("controls.speed")}
            onClick={() => onOpenPanel("speed")}
            value={labelForSpeed(codexSpeed)}
          />
        ) : null}
        <div className="fdy-chat-menu-separator" />
        <Button
          className="fdy-chat-menu-row fdy-chat-menu-reset"
          onClick={choose(onResetControls)}
          variant="ghost"
        >
          <strong>{t("controls.resetToProfile")}</strong>
          <RotateCcw size={17} />
        </Button>
      </div>
      <div className="fdy-chat-settings-submenu">
        {panel === "model" ? (
          <>
            <div className="fdy-chat-submenu-title">{t("controls.model")}</div>
            <ModelOptions
              choose={(id) => choose(() => onModelChange(id))}
              modelLoading={modelLoading}
              modelOptions={modelOptions}
              modelValue={modelValue}
              onRetryModels={onRetryModels}
              view={view}
            />
          </>
        ) : null}
        {panel === "effort" ? (
          <>
            <div className="fdy-chat-submenu-title">{t("controls.effort")}</div>
            {view.effortOptions.map((option) => (
              <Button
                className="fdy-chat-submenu-option"
                data-selected={option.value === view.effortValue}
                key={option.value}
                onClick={choose(() => onEffortChange(option.value))}
                variant="ghost"
              >
                <span>{option.label}</span>
                {option.value === view.effortValue ? <Check size={18} /> : null}
              </Button>
            ))}
          </>
        ) : null}
        {panel === "speed" ? (
          <>
            <div className="fdy-chat-submenu-title">{t("controls.speed")}</div>
            {codexSpeeds.map((speed) => (
              <Button
                className="fdy-chat-submenu-option fdy-chat-submenu-option-stacked"
                data-selected={codexSpeed === speed}
                key={speed}
                onClick={choose(() => onCodexSpeedChange(speed))}
                variant="ghost"
              >
                <span>
                  <strong>{t(`codexSpeed.${speed}`)}</strong>
                  <em>{t(`codexSpeedSummary.${speed}`)}</em>
                </span>
                {codexSpeed === speed ? <Check size={18} /> : null}
              </Button>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

function MainRow({
  label,
  onClick,
  value,
}: {
  label: string;
  onClick: () => void;
  value: string;
}) {
  return (
    <Button className="fdy-chat-menu-row" onClick={onClick} variant="ghost">
      <strong>{label}</strong>
      <span>{value}</span>
      <ChevronRight size={17} />
    </Button>
  );
}

/** The model submenu: a failed refresh note with retry, then the models. */
function ModelOptions({
  choose,
  modelLoading,
  modelOptions,
  modelValue,
  onRetryModels,
  view,
}: {
  choose: (id: string) => () => void;
  modelLoading: boolean;
  modelOptions: AgentModelOption[];
  modelValue: string;
  onRetryModels?: () => void;
  view: ModelAndEffortView;
}) {
  const { t } = useTranslation("agents");
  const { modelPanel } = view;
  return (
    <>
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
            onClick={choose(model.id)}
            variant="ghost"
          >
            <span>{compactModelLabel(model, model.id)}</span>
            {model.id === modelValue ? <Check size={18} /> : null}
          </Button>
        ))
      ) : (
        <div className="fdy-chat-submenu-empty">{modelPanel.emptyLabel}</div>
      )}
    </>
  );
}
