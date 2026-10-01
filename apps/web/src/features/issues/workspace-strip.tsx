import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("issues");
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
        {t("strip.clean", { baseline })}
      </span>
      <span className="fdy-workspace-strip-muted">
        {t("strip.counts", {
          accepted: acceptedCount,
          resolved: resolvedCount,
        })}
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
  ariaLabel,
  onValueChange,
  options,
  value,
}: WorkspaceStripControlProps<T>) {
  const { t } = useTranslation("issues");
  return (
    <SegmentedControl
      aria-label={ariaLabel ?? t("strip.viewLabel")}
      className="fdy-workspace-strip-control"
      onValueChange={onValueChange}
      options={options}
      value={value}
    />
  );
}
