import { Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Badge } from "../../components/ui/badge";
import { FactGrid, type FactGridItem } from "./fact-grid";
import { IconBox } from "../../components/ui/icon-box";
import { Panel } from "../../components/ui/panel";

export interface DeviceAssetPanelProps {
  actions: ReactNode;
  activeWorkers: ReactNode;
  className?: string;
  code: ReactNode;
  facts: FactGridItem[];
  identifier: ReactNode;
  label: ReactNode;
  online: boolean;
  tags: ReactNode;
}

export function DeviceAssetPanel({
  actions,
  activeWorkers,
  className,
  code,
  facts,
  identifier,
  label,
  online,
  tags,
}: DeviceAssetPanelProps) {
  const { t } = useTranslation("assets");
  return (
    <Panel className={cn("overflow-hidden px-[18px] py-[17px]", className)}>
      <div className="flex min-w-0 items-start gap-[13px] max-sidebar:grid max-sidebar:grid-cols-[42px_minmax(0,1fr)] max-sidebar:gap-x-[13px] max-sidebar:gap-y-0">
        <IconBox size="device" tone="device">
          <Monitor size={21} />
        </IconBox>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-[9px]">
            <strong className="min-w-0 truncate text-lg leading-tight font-bold text-ink">
              {label}
            </strong>
            <Badge
              className="min-w-[72px] justify-start"
              tone={online ? "online" : "neutral"}
            >
              {online ? t("device.online") : t("device.offline")}
            </Badge>
            <span className="flex-none text-2xs leading-none font-medium text-ink-faint">
              {activeWorkers}
            </span>
          </div>
          <code className="mb-[11px] block font-mono text-2xs leading-[1.4] font-medium text-ink-faint">
            {code}
          </code>
          <div className="flex flex-wrap gap-[7px]">{tags}</div>
        </div>
        <div className="flex flex-none flex-col items-end gap-[9px] max-sidebar:col-start-2 max-sidebar:w-full max-sidebar:flex-row max-sidebar:items-center max-sidebar:justify-between max-sidebar:gap-2 max-sidebar:pt-[7px]">
          <div className="flex gap-1.5 max-sidebar:flex-none">{actions}</div>
          <code className="block max-w-[180px] truncate text-right font-mono text-2xs leading-tight font-medium text-ink-faint max-sidebar:h-6 max-sidebar:w-auto max-sidebar:max-w-none max-sidebar:flex-1 max-sidebar:rounded-md max-sidebar:border max-sidebar:border-line-soft max-sidebar:bg-surface max-sidebar:px-2 max-sidebar:text-left max-sidebar:leading-6">
            {identifier}
          </code>
        </div>
      </div>
      <FactGrid layout="device" items={facts} />
    </Panel>
  );
}
