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
    <div
      className={cn(
        "box-border flex w-full min-w-0 flex-none flex-wrap items-center gap-2.5 px-6 pt-5 pb-3 max-[860px]:items-start max-[860px]:gap-y-2 max-[860px]:px-5.5 max-[860px]:pt-3.5 max-[860px]:pb-2.5",
        className,
      )}
      {...props}
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.75 truncate text-xs leading-tight font-semibold text-ink">
        <IconBox size="composer" tone="dark">
          {iconLabel}
        </IconBox>
        {workspaceName}
      </span>
      <span className="inline-block max-w-[min(340px,100%)] truncate font-mono text-2xs leading-[1.3] font-medium text-ink-faint max-[860px]:max-w-full">
        {localPath}
      </span>
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 truncate text-2xs leading-tight font-medium text-ink-muted">
        <span className="size-1.75 flex-none rounded-full bg-success-text" />
        {t("strip.clean", { baseline })}
      </span>
      <span className="min-w-0 truncate text-2xs leading-tight font-medium text-ink-faint">
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
      className="ml-auto flex-none max-[860px]:ml-0 max-[860px]:max-w-full"
      onValueChange={onValueChange}
      options={options}
      value={value}
    />
  );
}
