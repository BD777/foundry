import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { IconBox } from "../../components/ui/icon-box";
import { InfoRow } from "../../components/ui/info-row";
import { Panel, SectionLabel } from "../../components/ui/panel";

type IconTone = ComponentProps<typeof IconBox>["tone"];
type AssetEndWidth = 74 | 80 | 82 | 92;

const assetEndWidthClass: Record<AssetEndWidth, string> = {
  74: "fdy-asset-end-badge-74",
  80: "fdy-asset-end-badge-80",
  82: "fdy-asset-end-badge-82",
  92: "fdy-asset-end-badge-92",
};

export interface AssetSectionRow {
  end: ReactNode;
  endClassName?: string;
  endWidth?: AssetEndWidth;
  icon: LucideIcon;
  iconTone?: IconTone;
  id: string;
  label: ReactNode;
  meta: ReactNode;
}

export interface AssetSectionProps {
  icon: ReactNode;
  rows: AssetSectionRow[];
  title: ReactNode;
}

export function AssetSection({ icon, rows, title }: AssetSectionProps) {
  return (
    <section className="fdy-asset-section">
      <SectionLabel>
        {icon}
        {title}
      </SectionLabel>
      <Panel className="fdy-asset-section-panel">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <InfoRow
              icon={
                <IconBox size="row" tone={row.iconTone ?? "muted"}>
                  <Icon size={15} />
                </IconBox>
              }
              key={row.id}
              endClassName={cn(
                row.endWidth ? assetEndWidthClass[row.endWidth] : null,
                row.endClassName,
              )}
              label={row.label}
              meta={row.meta}
            >
              {row.end}
            </InfoRow>
          );
        })}
      </Panel>
    </section>
  );
}

export interface CapacityBarsProps {
  "aria-label": string;
  total: number;
  used: number;
}

export function CapacityBars({
  "aria-label": ariaLabel,
  total,
  used,
}: CapacityBarsProps) {
  return (
    <div aria-label={ariaLabel} className="fdy-capacity-bars">
      {Array.from({ length: total }, (_, index) => (
        <span
          className={cn(index < used && "fdy-capacity-bar-used")}
          data-state={index < used ? "used" : "available"}
          key={index}
        />
      ))}
    </div>
  );
}
