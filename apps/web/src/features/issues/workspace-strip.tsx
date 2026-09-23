import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { IconBox } from "../../components/ui/icon-box";
import {
  SegmentedControl,
  type SegmentOption,
} from "../../components/ui/segmented-control";

export interface WorkspaceStripProps extends HTMLAttributes<HTMLDivElement> {
  acceptedCount: number;
  baseline: string;
  iconLabel: ReactNode;
  localPath: ReactNode;
  resolvedCount: number;
  viewControl: ReactNode;
  workspaceName: ReactNode;
}

export function WorkspaceStrip({
  acceptedCount,
  baseline,
  className,
  iconLabel,
  localPath,
  resolvedCount,
  viewControl,
  workspaceName,
  ...props
}: WorkspaceStripProps) {
  return (
    <div className={cn("fdy-workspace-strip", className)} {...props}>
      <span className="fdy-workspace-chip">
        <IconBox size="composer" tone="dark">
          {iconLabel}
        </IconBox>
        {workspaceName}
      </span>
      <span className="fdy-mono-muted">{localPath}</span>
      <span className="fdy-branch-chip">
        <span className="fdy-branch-chip-dot" />
        {baseline} · clean
      </span>
      <span className="fdy-workspace-strip-muted">
        {acceptedCount} accepted · {resolvedCount} resolved
      </span>
      {viewControl}
    </div>
  );
}

export interface WorkspaceStripControlProps<T extends string> {
  ariaLabel?: string;
  onValueChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  value: T;
}

export function WorkspaceStripControl<T extends string>({
  ariaLabel = "Workspace view",
  onValueChange,
  options,
  value,
}: WorkspaceStripControlProps<T>) {
  return (
    <SegmentedControl
      aria-label={ariaLabel}
      className="fdy-workspace-strip-control"
      onValueChange={onValueChange}
      options={options}
      value={value}
    />
  );
}
