import { Check, ChevronRight, RotateCcw } from "lucide-react";
import type {
  AgentModelOption,
  ClaudeEffort,
  CodexReasoningEffort,
  CodexSpeed,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import {
  MenuRow,
  MenuRowLabel,
  MenuRowValue,
  MenuSeparator,
  SubmenuOption,
  SubmenuStackedName,
  SubmenuStackedSummary,
  SubmenuTitle,
} from "./runtime-menu-parts";
import {
  compactModelLabel,
  labelForSpeed,
  type ControlledRuntime,
  type ModelAndEffortView,
} from "./agent-runtime-labels";

export type SettingsPanel = "main" | "model" | "effort" | "speed";

const codexSpeeds: CodexSpeed[] = ["standard", "fast"];

const submenuCheck = <Check className="flex-none text-ink-muted" size={18} />;

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
      <div className="w-75 flex-none max-[860px]:w-[min(280px,calc(100vw-44px))]">
        <MainRow
          active={panel === "model"}
          label={t("controls.model")}
          onClick={() => onOpenPanel("model")}
          value={view.modelLabel}
        />
        <MainRow
          active={panel === "effort"}
          label={t("controls.effort")}
          onClick={() => onOpenPanel("effort")}
          value={view.effortLabel}
        />
        {selectedRuntime === "codex" ? (
          <MainRow
            active={panel === "speed"}
            label={t("controls.speed")}
            onClick={() => onOpenPanel("speed")}
            value={labelForSpeed(codexSpeed)}
          />
        ) : null}
        <MenuSeparator />
        <MenuRow
          className="grid-cols-[1fr_20px]"
          onClick={choose(onResetControls)}
        >
          <strong className="text-md font-[760] text-ink-faint">
            {t("controls.resetToProfile")}
          </strong>
          <RotateCcw size={17} />
        </MenuRow>
      </div>
      <div
        className={cn(
          "ml-2.5 max-h-[min(470px,calc(100vh-180px))] w-90 flex-none overflow-y-auto border-l border-line px-3 py-4",
          "max-[860px]:w-[min(300px,calc(100vw-44px))]",
          "max-[680px]:ml-0 max-[680px]:w-full max-[680px]:max-w-[calc(100vw-48px)] max-[680px]:border-t max-[680px]:border-l-0",
          panel === "main" && "hidden",
        )}
      >
        {panel === "model" ? (
          <>
            <SubmenuTitle>{t("controls.model")}</SubmenuTitle>
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
            <SubmenuTitle>{t("controls.effort")}</SubmenuTitle>
            {view.effortOptions.map((option) => (
              <SubmenuOption
                checkIcon={submenuCheck}
                key={option.value}
                onClick={choose(() => onEffortChange(option.value))}
                selected={option.value === view.effortValue}
              >
                {option.label}
              </SubmenuOption>
            ))}
          </>
        ) : null}
        {panel === "speed" ? (
          <>
            <SubmenuTitle>{t("controls.speed")}</SubmenuTitle>
            {codexSpeeds.map((speed) => (
              <SubmenuOption
                checkIcon={submenuCheck}
                key={speed}
                onClick={choose(() => onCodexSpeedChange(speed))}
                selected={codexSpeed === speed}
                stacked
              >
                <SubmenuStackedName>
                  {t(`codexSpeed.${speed}`)}
                </SubmenuStackedName>
                <SubmenuStackedSummary>
                  {t(`codexSpeedSummary.${speed}`)}
                </SubmenuStackedSummary>
              </SubmenuOption>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

function MainRow({
  active,
  label,
  onClick,
  value,
}: {
  /** Its submenu is the one open. */
  active: boolean;
  label: string;
  onClick: () => void;
  value: string;
}) {
  return (
    <MenuRow active={active} onClick={onClick}>
      <MenuRowLabel>{label}</MenuRowLabel>
      <MenuRowValue>{value}</MenuRowValue>
      <ChevronRight size={17} />
    </MenuRow>
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
        <Alert
          className="mx-1 mb-2 w-auto"
          role="status"
          size="compact"
          tone="warning"
          title={
            modelPanel.showOptions
              ? t("controls.modelRefreshFailedKept")
              : t("controls.modelRefreshFailed")
          }
          actions={
            onRetryModels ? (
              <Button
                disabled={modelLoading}
                onClick={onRetryModels}
                size="sm"
                variant="secondary"
              >
                <RotateCcw size={14} />
                {t("controls.retryRefresh")}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {modelPanel.showOptions ? (
        modelOptions.map((model) => (
          <SubmenuOption
            checkIcon={submenuCheck}
            key={model.id}
            onClick={choose(model.id)}
            selected={model.id === modelValue}
          >
            {compactModelLabel(model, model.id)}
          </SubmenuOption>
        ))
      ) : (
        <div className="p-3 text-md font-[650] text-ink-faint">
          {modelPanel.emptyLabel}
        </div>
      )}
    </>
  );
}
