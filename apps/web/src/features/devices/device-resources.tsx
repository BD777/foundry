import type { DeviceProjection, DeviceResource } from "@foundry/protocol";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { InfoRow } from "../../components/ui/info-row";

const kindLabels: Record<DeviceResource["kind"], string> = {
  browser: "Browser",
  computer_use: "Screen control",
};

/**
 * The Resource Pool directory for one device: what its worker found that
 * sessions may use. Foundry lists the device's own software; it installs
 * nothing, so this is read-only.
 */
export function DeviceResources({ device }: { device: DeviceProjection }) {
  const resources = device.resources ?? [];
  return (
    <section
      className="fdy-device-section"
      aria-labelledby="fdy-device-resources-heading"
    >
      <h2 id="fdy-device-resources-heading">Resources</h2>
      <p>
        Software on {device.label} that sessions may use, detected by its worker
        when it connects. Foundry never installs resources.
      </p>
      {resources.length === 0 ? (
        <EmptyState
          title="No resources reported"
          body={
            device.status === "connected"
              ? "The worker found no browser or screen control on this device."
              : "The device has not reported its resources; they appear after its worker connects."
          }
        />
      ) : (
        <ul className="fdy-device-resources" aria-label="Device resources">
          {resources.map((resource) => (
            <li key={resource.id}>
              <InfoRow
                label={`${resource.name} · ${kindLabels[resource.kind] ?? resource.kind}`}
                meta={resource.attributes?.path}
              >
                <Badge tone={resource.available ? "online" : "warn"}>
                  {resource.available ? "Available" : "Not available"}
                </Badge>
              </InfoRow>
              {resource.detail ? (
                <p className="fdy-device-resource-detail">{resource.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
