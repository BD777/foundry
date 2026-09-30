import { useState } from "react";
import type { DeviceProjection, DeviceResource } from "@bd777/foundry-protocol";
import { refreshDeviceResources } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { InfoRow } from "../../components/ui/info-row";

const kindLabels: Record<DeviceResource["kind"], string> = {
  browser: "Browser",
  computer_use: "Screen control",
};

/**
 * The Resource Pool directory for one device: what its worker found that
 * sessions may use. Foundry lists the device's own software and installs
 * nothing. The device's owner can have it detect again, and for a resource
 * that needs the person's permission (macOS screen control) have the device
 * show its permission prompts and open the right System Settings pane.
 */
export function DeviceResources({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const resources = device.resources ?? [];
  const manageable = Boolean(device.owned) && device.status === "connected";
  const [busy, setBusy] = useState<"detect" | "access" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async (requestAccess?: string) => {
    setBusy(requestAccess ? "access" : "detect");
    setMessage("");
    setError("");
    try {
      const result = await refreshDeviceResources(device.id, requestAccess);
      await onRefresh();
      const pending = result.resources.find(
        (resource) => resource.id === requestAccess && !resource.available,
      );
      setMessage(
        !requestAccess
          ? "Resources detected again."
          : result.opened.length && pending
            ? `System Settings is open on ${device.label} (${result.opened.join(", ")}). Turn on the Foundry worker there, then choose Detect again.`
            : pending
              ? `${device.label} showed its permission prompts. Allow them there, then choose Detect again.`
              : "Access is granted.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reach the device.",
      );
    } finally {
      setBusy(null);
    }
  };

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
      {manageable ? (
        <div className="fdy-device-resource-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            {busy === "detect" ? "Detecting…" : "Detect again"}
          </Button>
        </div>
      ) : null}
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
              {resource.kind === "computer_use" &&
              !resource.available &&
              manageable ? (
                <div className="fdy-device-resource-access">
                  <p>
                    To let sessions capture and control this Mac, allow the
                    program running the Foundry worker
                    {resource.attributes?.grantTo ? (
                      <>
                        {" "}
                        (<code>{resource.attributes.grantTo}</code>)
                      </>
                    ) : null}{" "}
                    under Screen Recording and Accessibility. The prompts and
                    System Settings open on {device.label}.
                  </p>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void refresh(resource.id)}
                  >
                    {busy === "access"
                      ? "Asking the device…"
                      : "Open System Settings…"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p className="fdy-device-resource-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
