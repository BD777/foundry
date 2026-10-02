import type {
  RunEvent,
  SkillPackRef,
  WorkerRuntimeId,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { ChecklistRow } from "../../components/ui/checklist-row";
import { EmptyState } from "../../components/ui/empty-state";
import {
  MetaPill,
  MetaPillCaption,
  MetaPillDot,
} from "../../components/ui/meta-pill";
import { Panel, SectionLabel } from "../../components/ui/panel";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { TimelineItem } from "./timeline-item";
import { displayProcessLabel } from "../../lib/process-labels";

export interface IssueRunTimelineProps {
  events: RunEvent[];
  runtime: WorkerRuntimeId;
  skills: SkillPackRef[];
}

export function IssueRunTimeline({
  events,
  runtime,
  skills,
}: IssueRunTimelineProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <section className="fdy-detail-block">
      <SectionLabel>{t("sections.runtimeSkills")}</SectionLabel>
      <div className="fdy-runtime-pack-row">
        <MetaPill>
          <RuntimeMark runtime={runtime} />
          {runtimeMeta(runtime).label}
          <MetaPillCaption>{t("sections.runtimeCaption")}</MetaPillCaption>
        </MetaPill>
        <span className="fdy-with-label">{t("sections.with")}</span>
        {skills.map((skill) => (
          <MetaPill key={skill.id} mono>
            <MetaPillDot />
            {skill.name}
            <MetaPillCaption>
              {t("shared.version", { version: skill.version })}
            </MetaPillCaption>
          </MetaPill>
        ))}
      </div>
      <p className="fdy-detail-helper-copy">{t("sections.workersNote")}</p>
      <div className="fdy-timeline-heading">
        <SectionLabel>{t("sections.runEvents")}</SectionLabel>
        <span className="fdy-live-chip">
          <span />
          {t("sections.live")}
        </span>
      </div>
      <Panel className="fdy-timeline-panel">
        {events.length ? (
          events.map((event, index) => (
            <TimelineItem
              key={event.id}
              label={displayProcessLabel(event.label)}
              meta={
                <>
                  {event.detail} · {event.at}
                </>
              }
              status={index === events.length - 1 ? "active" : "done"}
            />
          ))
        ) : (
          <EmptyState
            body={t("sections.noEventsBody")}
            title={t("sections.noEventsTitle")}
          />
        )}
      </Panel>
    </section>
  );
}

export interface IssueCriteriaProps {
  criteria: string[];
}

export function IssueCriteria({ criteria }: IssueCriteriaProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <section className="fdy-detail-block">
      <SectionLabel>{t("sections.acceptanceCriteria")}</SectionLabel>
      <Panel className="fdy-criteria-panel">
        {criteria.map((criterion) => (
          <ChecklistRow key={criterion} marker="dot" tone="neutral">
            {criterion}
          </ChecklistRow>
        ))}
      </Panel>
    </section>
  );
}
