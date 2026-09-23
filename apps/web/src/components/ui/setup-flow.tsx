import type { ReactNode } from "react";
import { Button } from "./button";
import { Panel } from "./panel";
import { TerminalBlock } from "./terminal-block";

export interface SetupFlowStep {
  commands?: ReactNode[];
  hint: ReactNode;
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
    <section className="fdy-setup-screen">
      <div className="fdy-setup-main">
        <div className="fdy-setup-kicker">
          <span />
          {kicker}
        </div>
        <h1>{title}</h1>
        <p>{body}</p>

        <div className="fdy-setup-steps">
          {steps.map((step) => (
            <SetupStep key={String(step.number)} step={step} />
          ))}
        </div>

        <div className="fdy-setup-actions">
          <Button
            className="fdy-setup-action-button"
            onClick={onAction}
            size="lg"
            variant="primary"
          >
            <span className="fdy-setup-action-dot" />
            {actionLabel}
          </Button>
          <span>{status}</span>
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

  return (
    <Panel className="fdy-setup-step" data-state={state}>
      <div className="fdy-setup-step-heading">
        <span>{step.number}</span>
        <strong>{step.title}</strong>
        <em>{step.hint}</em>
      </div>
      {step.commands ? (
        <TerminalBlock
          className="fdy-setup-terminal"
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
