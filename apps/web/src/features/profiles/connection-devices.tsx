import { useState } from "react";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { connectionSelection } from "../../lib/model-connections";

export function ConnectionDevices({
  devices,
  bindings,
  profile,
  onSave,
}: {
  devices: DeviceProjection[];
  bindings: DeviceProfileBinding[];
  profile: ProfileDefinition;
  onSave: (deviceId: string, profileIds: string[]) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="fdy-connection-devices">
      <strong>Device access</strong>
      <p>
        Choose which devices may use this connection. The key stays sealed on
        the server and is sent only for execution or an explicit catalog read.
      </p>
      {!devices.length ? (
        <p>Connect a device from Devices to assign this connection.</p>
      ) : null}
      {devices.map((device) => {
        const assigned = bindings.some(
          (row) =>
            row.deviceId === device.id &&
            row.profileId === profile.id &&
            row.enabled,
        );
        return (
          <div className="fdy-management-row" key={device.id}>
            <span>
              <strong>{device.label}</strong>
              <small>
                {device.status === "connected"
                  ? "Online"
                  : "Offline · assignment applies when it reconnects"}
              </small>
            </span>
            <Badge tone="neutral">
              {assigned ? "Assigned" : "Not assigned"}
            </Badge>
            {/* Granting access is a single click; removing it — a destructive
                change on another device — needs an explicit second click. */}
            {assigned ? (
              <ConfirmButton
                confirmLabel={`Remove ${profile.label} from ${device.label}?`}
                disabled={busy}
                onConfirm={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onSave(
                      device.id,
                      connectionSelection(
                        bindings,
                        device.id,
                        profile.id,
                        false,
                      ),
                    );
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not update device access.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                size="sm"
                variant="secondary"
                aria-label={`Remove ${profile.label} from ${device.label}`}
              >
                Remove access
              </ConfirmButton>
            ) : (
              <Button
                disabled={busy}
                size="sm"
                variant="secondary"
                aria-label={`Assign ${profile.label} to ${device.label}`}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onSave(
                      device.id,
                      connectionSelection(
                        bindings,
                        device.id,
                        profile.id,
                        true,
                      ),
                    );
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not update device access.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Assign
              </Button>
            )}
          </div>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
