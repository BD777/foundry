import type {
  RunEvent,
  SkillPackRef,
  WorkerRuntimeId,
} from "@foundry/protocol";
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
  return (
    <section className="fdy-detail-block">
      <SectionLabel>Worker runtime & skills</SectionLabel>
      <div className="fdy-runtime-pack-row">
        <MetaPill>
          <RuntimeMark runtime={runtime} />
          {runtimeMeta(runtime).label}
          <MetaPillCaption>runtime · stateless</MetaPillCaption>
        </MetaPill>
        <span className="fdy-with-label">with</span>
        {skills.map((skill) => (
          <MetaPill key={skill.id} mono>
            <MetaPillDot />
            {skill.name}
            <MetaPillCaption>v{skill.version}</MetaPillCaption>
          </MetaPill>
        ))}
      </div>
      <p className="fdy-detail-helper-copy">
        Workers do not remember. Everything for this run comes from the
        workspace context and the loaded skill packs.
      </p>
      <div className="fdy-timeline-heading">
        <SectionLabel>Run events</SectionLabel>
        <span className="fdy-live-chip">
          <span />
          live
        </span>
      </div>
      <Panel className="fdy-timeline-panel">
        {events.length ? (
          events.map((event, index) => (
            <TimelineItem
              key={event.id}
              label={event.label}
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
            body="Run events appear after a local worker starts."
            title="No run events"
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
  return (
    <section className="fdy-detail-block">
      <SectionLabel>Acceptance criteria</SectionLabel>
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
