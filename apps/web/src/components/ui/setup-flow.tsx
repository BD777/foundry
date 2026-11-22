import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { FieldHint } from "./field";
import { Panel } from "./panel";
import { TerminalBlock } from "./terminal-block";

export interface SetupFlowStep {
  commands?: ReactNode[];
  /** The step's one short line of detail, beside its title. */
  meta: ReactNode;
  number: ReactNode;
  state?: "primary" | "muted";
  title: ReactNode;
}

export interface SetupFlowProps {
  actionLabel: ReactNode;
  body: ReactNode;
  kicker: ReactNode;
  onAction: () => void;
  status: ReactNode;
  steps: SetupFlowStep[];
  title: ReactNode;
}

export function SetupFlow({
  actionLabel,
  body,
  kicker,
  onAction,
  status,
  steps,
  title,
}: SetupFlowProps) {
  return (
    // Its own scroller inside a contained view; the reserved scrollbar space
    // keeps the centered steps still.
    <section className="h-full animate-page-fade overflow-x-hidden overflow-y-auto px-[30px] pt-10 pb-[60px] [scrollbar-gutter:stable] max-sidebar:px-[22px] max-sidebar:pt-7 max-sidebar:pb-[46px]">
      <div className="mx-auto max-w-[720px]">
        <div className="mb-2 flex items-center gap-2.5 text-xs leading-none font-semibold text-ink-faint">
          <span className="size-[9px] flex-none rounded-full bg-line-strong" />
          {kicker}
        </div>
        <h1 className="mb-2 text-2xl leading-[1.15] font-bold text-ink">
          {title}
        </h1>
        <p className="mb-[26px] max-w-[560px] text-md leading-[1.55] text-ink-muted max-sidebar:mb-[22px] [&_em]:[font:inherit] [&_em]:text-inherit [&_em]:italic">
          {body}
        </p>

        <div className="flex flex-col gap-3.5 max-sidebar:gap-3">
          {steps.map((step) => (
            <SetupStep key={String(step.number)} step={step} />
          ))}
        </div>

        <div className="mt-6 flex min-w-0 items-center gap-3 max-sidebar:mt-[18px] max-sidebar:flex-col max-sidebar:items-start max-sidebar:gap-2">
          <Button
            className="h-[38px] gap-2 rounded-md px-[18px] text-sm"
            onClick={onAction}
            size="lg"
            variant="primary"
          >
            {actionLabel}
          </Button>
          <FieldHint
            as="span"
            className="mt-0 max-w-[340px] font-medium max-sidebar:max-w-full"
          >
            {status}
          </FieldHint>
        </div>
      </div>
    </section>
  );
}

interface SetupStepProps {
  step: SetupFlowStep;
}

function SetupStep({ step }: SetupStepProps) {
  const state = step.state ?? "muted";
  const muted = state === "muted";

  return (
    <Panel
      className={cn(
        "overflow-hidden",
        muted
          ? "p-[18px] opacity-[0.62] max-sidebar:px-3.5 max-sidebar:py-[15px]"
          : "px-[18px] pt-[18px] pb-4 max-sidebar:px-3.5 max-sidebar:pt-[15px] max-sidebar:pb-3.5",
      )}
      data-state={state}
    >
      <div className="flex w-full min-w-0 items-start gap-[11px]">
        <span
          className={cn(
            "size-6 flex-none rounded-full text-center text-xs leading-6 font-bold",
            muted ? "bg-panel-soft text-ink-faint" : "bg-brand text-on-brand",
          )}
        >
          {step.number}
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="min-w-0 text-md leading-6 font-semibold text-ink wrap-anywhere">
            {step.title}
          </strong>
          <small className="min-w-0 text-xs leading-normal font-medium text-ink-muted wrap-anywhere">
            {step.meta}
          </small>
        </span>
      </div>
      {step.commands ? (
        <TerminalBlock
          className="mt-3"
          viewportClassName="max-sidebar:overflow-hidden"
          lines={step.commands.map((command, index) => ({
            id: `${String(step.number)}-${index}`,
            prompt: "$",
            value: command,
          }))}
        />
      ) : null}
    </Panel>
  );
}
