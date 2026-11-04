import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button, type ButtonProps } from "../../components/ui/button";
import {
  ChecklistRow,
  type ChecklistRowProps,
} from "../../components/ui/checklist-row";
import { FieldHint } from "../../components/ui/field";
import { InfoRow } from "../../components/ui/info-row";
import {
  MetaPill,
  MetaPillCaption,
  MetaPillDot,
} from "../../components/ui/meta-pill";
import { Panel, SectionLabel } from "../../components/ui/panel";
import { cn } from "../../lib/cn";

type BadgeTone = NonNullable<BadgeProps["tone"]>;
type ButtonVariant = NonNullable<ButtonProps["variant"]>;
type CheckMarker = NonNullable<ChecklistRowProps["marker"]>;
type CheckTone = NonNullable<ChecklistRowProps["tone"]>;

export interface IssueInspectorAction {
  className?: string;
  disabled?: boolean;
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
}

interface IssueInspectorStatus {
  label: string;
  tone: BadgeTone;
}

interface IssueInspectorCheck {
  id: string;
  label: ReactNode;
  marker: CheckMarker;
  tone: CheckTone;
}

interface IssueInspectorSkill {
  id: string;
  name: string;
  version: string;
}

export type IssueInspectorProps =
  | {
      actions: IssueInspectorAction[];
      checks: IssueInspectorCheck[];
      footer: ReactNode;
      mode: "review";
      skills: IssueInspectorSkill[];
      status: IssueInspectorStatus;
    }
  | {
      deviceLabel: ReactNode;
      mode: "producing";
      onCancel: () => void;
      runtimeLabel: ReactNode;
      startedLabel: ReactNode;
      status: IssueInspectorStatus;
    }
  | {
      actions: IssueInspectorAction[];
      footer: ReactNode;
      mode: "contract";
      readinessLabel: ReactNode;
      runtimeLabel: ReactNode;
      status: IssueInspectorStatus;
    };

const blockClass = "mt-5 min-w-0";
const detailPanelClass =
  "overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none";
const detailRowClass = "border-t-line";
const priorityRowClass = "px-2.75";
const actionsClass = "mt-6 flex min-w-0 flex-col gap-2.25";
const inspectorActionClass =
  "w-full gap-2 overflow-hidden rounded-md text-ellipsis";

function PriorityStep({
  children,
  primary = false,
}: {
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-4.25 items-center justify-center rounded-full text-2xs leading-none font-bold",
        primary ? "bg-brand text-on-brand" : "bg-panel-soft text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

export function IssueInspector(props: IssueInspectorProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <aside className="box-border h-full w-79 min-w-0 flex-none overflow-y-auto border-l border-line bg-surface px-5 py-5.5 max-[860px]:h-auto max-[860px]:w-auto max-[860px]:max-w-full max-[860px]:overflow-visible max-[860px]:rounded-xl max-[860px]:border-t max-[860px]:border-l-0 max-[860px]:p-3.5 max-[860px]:shadow-card">
      <SectionLabel className="mb-2.75">{t("inspector.status")}</SectionLabel>
      <Badge
        className="max-w-full min-w-[150px] justify-start overflow-hidden text-ellipsis"
        tone={props.status.tone}
      >
        {props.status.label}
      </Badge>

      {props.mode === "review" ? <ReviewInspector {...props} /> : null}
      {props.mode === "producing" ? <ProducingInspector {...props} /> : null}
      {props.mode === "contract" ? <ContractInspector {...props} /> : null}
    </aside>
  );
}

function ReviewInspector(
  props: Extract<IssueInspectorProps, { mode: "review" }>,
) {
  const { t } = useTranslation("issueDetail");
  return (
    <>
      <div className="mt-4.5 min-w-0">
        <SectionLabel className="mb-2.25">{t("inspector.checks")}</SectionLabel>
        <div className="flex min-w-0 flex-col gap-1.75">
          {props.checks.map((check) => (
            <ChecklistRow
              className="items-center gap-2 font-medium"
              key={check.id}
              shape="round"
              marker={check.marker}
              tone={check.tone}
            >
              {check.label}
            </ChecklistRow>
          ))}
        </div>
      </div>

      <div className={blockClass}>
        <SectionLabel className="mb-2.25">
          {t("inspector.skillPacksUsed")}
        </SectionLabel>
        <div className="flex min-w-0 flex-wrap gap-1.75">
          {props.skills.map((skill) => (
            <MetaPill
              className="max-w-full min-w-0 overflow-hidden text-ellipsis"
              key={skill.id}
              mono
              size="chip"
            >
              <MetaPillDot />
              {skill.name}
              <MetaPillCaption>
                {t("shared.version", { version: skill.version })}
              </MetaPillCaption>
            </MetaPill>
          ))}
        </div>
      </div>

      <InspectorActions actions={props.actions} />
      <FieldHint
        className={props.actions.length > 0 ? "mx-0.5 mt-3" : "mt-1.5"}
      >
        {props.footer}
      </FieldHint>
    </>
  );
}

function ProducingInspector(
  props: Extract<IssueInspectorProps, { mode: "producing" }>,
) {
  const { t } = useTranslation("issueDetail");
  return (
    <>
      <div className={blockClass}>
        <Panel className={detailPanelClass}>
          <InfoRow
            className={detailRowClass}
            density="compact"
            label={t("inspector.runtime")}
            variant="keyValue"
          >
            <strong>{props.runtimeLabel}</strong>
          </InfoRow>
          <InfoRow
            className={detailRowClass}
            density="compact"
            label={t("inspector.device")}
            variant="keyValue"
          >
            <code>{props.deviceLabel}</code>
          </InfoRow>
          <InfoRow
            className={detailRowClass}
            density="compact"
            label={t("inspector.started")}
            variant="keyValue"
          >
            <strong>{props.startedLabel}</strong>
          </InfoRow>
        </Panel>
      </div>

      <div className={blockClass}>
        <SectionLabel className="mb-2.25">
          {t("inspector.contextPriority")}
        </SectionLabel>
        <Panel className="overflow-hidden rounded-lg border-line bg-panel p-0 shadow-none">
          <InfoRow
            className={cn(priorityRowClass, "bg-panel-soft")}
            density="compact"
            tone="warning"
            icon={<PriorityStep primary>1</PriorityStep>}
            label={t("inspector.workspaceContext")}
            meta={t("inspector.authoritative")}
          />
          <InfoRow
            className={priorityRowClass}
            density="compact"
            icon={<PriorityStep>2</PriorityStep>}
            label={t("inspector.skillPacks")}
            meta={t("inspector.reusable")}
          />
          <InfoRow
            className={priorityRowClass}
            density="compact"
            icon={<PriorityStep>3</PriorityStep>}
            label={t("inspector.workerRuntime")}
            meta={t("inspector.executionOnly")}
          />
        </Panel>
      </div>

      <div className={actionsClass}>
        <Button
          className={cn(
            inspectorActionClass,
            "h-9.5 text-xs disabled:bg-panel disabled:text-ink-faint",
          )}
          disabled
          size="lg"
          variant="secondary"
        >
          {t("inspector.artifactPending")}
        </Button>
        <Button
          className={cn(
            inspectorActionClass,
            "h-9.5 text-xs text-ink-faint hover:bg-error-surface hover:text-error-text",
          )}
          onClick={props.onCancel}
          size="lg"
          variant="secondary"
        >
          {t("inspector.stop")}
        </Button>
      </div>
    </>
  );
}

function ContractInspector(
  props: Extract<IssueInspectorProps, { mode: "contract" }>,
) {
  const { t } = useTranslation("issueDetail");
  return (
    <>
      <div className={blockClass}>
        <Panel className={detailPanelClass}>
          <InfoRow
            className={detailRowClass}
            density="compact"
            label={t("inspector.readiness")}
            variant="keyValue"
          >
            <strong>{props.readinessLabel}</strong>
          </InfoRow>
          <InfoRow
            className={detailRowClass}
            density="compact"
            label={t("inspector.runtime")}
            variant="keyValue"
          >
            <strong>{props.runtimeLabel}</strong>
          </InfoRow>
        </Panel>
      </div>

      <InspectorActions actions={props.actions} />
      <FieldHint
        className={props.actions.length > 0 ? "mx-0.5 mt-3" : "mt-1.5"}
      >
        {props.footer}
      </FieldHint>
    </>
  );
}

function InspectorActions({ actions }: { actions: IssueInspectorAction[] }) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className={actionsClass}>
      {actions.map((action) => {
        const Icon = action.icon;

        return (
          <Button
            key={action.label}
            className={cn(inspectorActionClass, action.className)}
            disabled={action.disabled}
            onClick={action.onClick}
            size="lg"
            variant={action.variant}
          >
            {Icon ? <Icon size={15} /> : null}
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}
