import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { FactGrid, type FactGridItem } from "./fact-grid";
import { IconBox } from "../../components/ui/icon-box";
import { Panel } from "../../components/ui/panel";

export interface DeviceAssetPanelProps {
  actions: ReactNode;
  activeWorkers: ReactNode;
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
  code,
  facts,
  identifier,
  label,
  online,
  tags,
}: DeviceAssetPanelProps) {
  return (
    <Panel className="fdy-device-asset-panel">
      <div className="fdy-device-asset-main">
        <IconBox className="fdy-device-asset-icon" size="device" tone="device">
          <Monitor size={21} />
        </IconBox>
        <div className="fdy-device-asset-copy">
          <div className="fdy-device-asset-title">
            <strong>{label}</strong>
            <Badge tone={online ? "online" : "neutral"}>
              {online ? "Online" : "Offline"}
            </Badge>
            <span>{activeWorkers}</span>
          </div>
          <code>{code}</code>
          <div className="fdy-device-asset-tags">{tags}</div>
        </div>
        <div className="fdy-device-asset-actions">
          <div className="fdy-device-action-buttons">{actions}</div>
          <code>{identifier}</code>
        </div>
      </div>
      <FactGrid className="fdy-device-asset-facts" items={facts} />
    </Panel>
  );
}
