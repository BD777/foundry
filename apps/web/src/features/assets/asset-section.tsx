import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Badge } from "../../components/ui/badge";
import { IconBox } from "../../components/ui/icon-box";
import { InfoRow } from "../../components/ui/info-row";
import { Panel, SectionLabel } from "../../components/ui/panel";

type IconTone = ComponentProps<typeof IconBox>["tone"];
type AssetStatusWidth = 80 | 82 | 92;

/**
 * The status badge keeps one width per row group so the badges line up. It
 * sits in its own span: the row's end slot sets `min-w-0` on its children.
 */
const assetStatusWidthClass: Record<AssetStatusWidth, string> = {
  80: "min-w-[80px] max-[860px]:min-w-[70px]",
  82: "min-w-[82px] max-[860px]:min-w-[72px]",
  92: "min-w-[92px] max-[860px]:min-w-[78px]",
};

export interface AssetSectionRow {
  icon: LucideIcon;
  iconTone?: IconTone;
  id: string;
  label: ReactNode;
  meta: ReactNode;
  status: {
    label: ReactNode;
    tone: ComponentProps<typeof Badge>["tone"];
    width?: AssetStatusWidth;
  };
}

export interface AssetSectionProps {
  className?: string;
  icon: ReactNode;
  rows: AssetSectionRow[];
  title: ReactNode;
}

export function AssetSection({
  className,
  icon,
  rows,
  title,
}: AssetSectionProps) {
  return (
    <section className={cn("block", className)}>
      <SectionLabel className="mb-[9px]">
        {icon}
        {title}
      </SectionLabel>
      <Panel className="overflow-hidden px-4 py-0.5">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <InfoRow
              className="first:border-t first:border-line-soft max-[860px]:grid max-[860px]:grid-cols-[30px_minmax(0,1fr)_minmax(66px,auto)] max-[860px]:items-center max-[860px]:gap-[9px] max-[860px]:py-[11px]"
              icon={
                <IconBox size="row" tone={row.iconTone ?? "muted"}>
                  <Icon size={15} />
                </IconBox>
              }
              key={row.id}
              endClassName="max-[860px]:max-w-full max-[860px]:flex-nowrap"
              label={row.label}
              meta={row.meta}
            >
              <span className="flex">
                <Badge
                  className={cn(
                    "justify-start max-[860px]:max-w-[78px] max-[860px]:overflow-hidden max-[860px]:text-ellipsis max-[860px]:whitespace-nowrap",
                    row.status.width && assetStatusWidthClass[row.status.width],
                  )}
                  tone={row.status.tone}
                >
                  {row.status.label}
                </Badge>
              </span>
            </InfoRow>
          );
        })}
      </Panel>
    </section>
  );
}
