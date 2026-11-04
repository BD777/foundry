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
      <div className="flex min-w-0 items-start gap-[13px] max-[860px]:grid max-[860px]:grid-cols-[42px_minmax(0,1fr)] max-[860px]:gap-x-[13px] max-[860px]:gap-y-0">
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
        <div className="flex flex-none flex-col items-end gap-[9px] max-[860px]:col-start-2 max-[860px]:w-full max-[860px]:flex-row max-[860px]:items-center max-[860px]:justify-between max-[860px]:gap-2 max-[860px]:pt-[7px]">
          <div className="flex gap-1.5 max-[860px]:flex-none">{actions}</div>
          <code className="block max-w-[180px] truncate text-right font-mono text-2xs leading-tight font-medium text-ink-faint max-[860px]:h-6 max-[860px]:w-auto max-[860px]:max-w-none max-[860px]:flex-1 max-[860px]:rounded-md max-[860px]:border max-[860px]:border-line-soft max-[860px]:bg-surface max-[860px]:px-2 max-[860px]:text-left max-[860px]:leading-6">
            {identifier}
          </code>
        </div>
      </div>
      <FactGrid layout="device" items={facts} />
    </Panel>
  );
}
