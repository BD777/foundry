import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button, type ButtonProps } from "../../components/ui/button";
import {
  ChecklistRow,
  type ChecklistRowProps,
} from "../../components/ui/checklist-row";
import { InfoRow } from "../../components/ui/info-row";
import {
  MetaPill,
  MetaPillCaption,
  MetaPillDot,
} from "../../components/ui/meta-pill";
import { Panel, SectionLabel } from "../../components/ui/panel";

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

export function IssueInspector(props: IssueInspectorProps) {
  return (
    <aside className="fdy-issue-inspector">
      <SectionLabel>Status</SectionLabel>
      <Badge className="fdy-inspector-status-badge" tone={props.status.tone}>
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
  return (
    <>
      <div className="fdy-inspector-block">
        <SectionLabel>Checks</SectionLabel>
        <div className="fdy-check-list">
          {props.checks.map((check) => (
            <ChecklistRow
              key={check.id}
              marker={check.marker}
              tone={check.tone}
            >
              {check.label}
            </ChecklistRow>
          ))}
        </div>
      </div>

      <div className="fdy-inspector-block">
        <SectionLabel>Skill packs used</SectionLabel>
        <div className="fdy-skill-chip-list">
          {props.skills.map((skill) => (
            <MetaPill key={skill.id} mono size="chip">
              <MetaPillDot />
              {skill.name}
              <MetaPillCaption>v{skill.version}</MetaPillCaption>
            </MetaPill>
          ))}
        </div>
      </div>

      <InspectorActions actions={props.actions} />
      <p className="fdy-inspector-note">{props.footer}</p>
    </>
  );
}

function ProducingInspector(
  props: Extract<IssueInspectorProps, { mode: "producing" }>,
) {
  return (
    <>
      <div className="fdy-inspector-block fdy-producing-contract-block">
        <Panel className="fdy-inspector-detail-panel">
          <InfoRow density="compact" label="Runtime" variant="keyValue">
            <strong>{props.runtimeLabel}</strong>
          </InfoRow>
          <InfoRow density="compact" label="Device" variant="keyValue">
            <code>{props.deviceLabel}</code>
          </InfoRow>
          <InfoRow density="compact" label="Started" variant="keyValue">
            <strong>{props.startedLabel}</strong>
          </InfoRow>
        </Panel>
      </div>

      <div className="fdy-inspector-block">
        <SectionLabel>Context priority</SectionLabel>
        <Panel className="fdy-context-priority-panel">
          <InfoRow
            className="fdy-priority-row fdy-priority-row-primary"
            density="compact"
            icon={<span className="fdy-priority-step">1</span>}
            label="Workspace context"
            meta="authoritative"
          />
          <InfoRow
            className="fdy-priority-row"
            density="compact"
            icon={<span className="fdy-priority-step">2</span>}
            label="Skill packs"
            meta="reusable"
          />
          <InfoRow
            className="fdy-priority-row"
            density="compact"
            icon={<span className="fdy-priority-step">3</span>}
            label="Worker runtime"
            meta="execution only"
          />
        </Panel>
      </div>

      <div className="fdy-inspector-actions">
        <Button
          className="fdy-pending-artifact-button"
          disabled
          size="lg"
          variant="secondary"
        >
          Artifact appears here when ready
        </Button>
        <Button
          className="fdy-danger-action"
          onClick={props.onCancel}
          size="lg"
          variant="secondary"
        >
          Stop execution
        </Button>
      </div>
    </>
  );
}

function ContractInspector(
  props: Extract<IssueInspectorProps, { mode: "contract" }>,
) {
  return (
    <>
      <div className="fdy-inspector-block fdy-contract-detail-block">
        <Panel className="fdy-inspector-detail-panel">
          <InfoRow density="compact" label="Readiness" variant="keyValue">
            <strong>{props.readinessLabel}</strong>
          </InfoRow>
          <InfoRow density="compact" label="Runtime" variant="keyValue">
            <strong>{props.runtimeLabel}</strong>
          </InfoRow>
        </Panel>
      </div>

      <InspectorActions actions={props.actions} />
      <p className="fdy-inspector-note">{props.footer}</p>
    </>
  );
}

function InspectorActions({ actions }: { actions: IssueInspectorAction[] }) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="fdy-inspector-actions">
      {actions.map((action) => {
        const Icon = action.icon;

        return (
          <Button
            key={action.label}
            className={action.className}
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
