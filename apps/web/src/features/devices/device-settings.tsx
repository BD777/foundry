import { useState } from "react";
import type { DeviceProjection } from "@foundry/protocol";
import { saveAgentRuntimeSettings } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";

export function DeviceSettings({
  device,
  onRefresh,
  onRemoveDevice,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
  onRemoveDevice: () => void;
}) {
  const [draft, setDraft] = useState(
    device.runtimeSettings ?? {
      activeRuntimeTtlMs: 900000,
      maxConcurrentTasks: 4,
    },
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="fdy-device-section">
      <h2>Execution settings</h2>
      <p>Shared by every workspace on {device.label}.</p>
      <div className="fdy-device-settings-fields">
        <label>
          Maximum concurrent tasks
          <TextInput
            tone="boxed"
            aria-label="Maximum concurrent tasks"
            type="number"
            min={1}
            max={16}
            value={draft.maxConcurrentTasks}
            onChange={(event) =>
              setDraft({
                ...draft,
                maxConcurrentTasks: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label>
          Active runtime cache (minutes)
          <TextInput
            tone="boxed"
            aria-label="Runtime cache minutes"
            type="number"
            min={1}
            value={draft.activeRuntimeTtlMs / 60000}
            onChange={(event) =>
              setDraft({
                ...draft,
                activeRuntimeTtlMs: Number(event.currentTarget.value) * 60000,
              })
            }
          />
        </label>
      </div>
      <Button
        disabled={
          busy ||
          device.status !== "connected" ||
          !Number.isInteger(draft.maxConcurrentTasks) ||
          draft.maxConcurrentTasks < 1 ||
          draft.maxConcurrentTasks > 16 ||
          !Number.isFinite(draft.activeRuntimeTtlMs) ||
          draft.activeRuntimeTtlMs < 60000
        }
        size="sm"
        variant="primary"
        onClick={async () => {
          setBusy(true);
          setMessage("");
          try {
            await saveAgentRuntimeSettings({
              deviceId: device.id,
              settings: draft,
            });
            await onRefresh();
            setMessage("Settings saved.");
          } catch (cause) {
            setMessage(
              cause instanceof Error
                ? cause.message
                : "Could not save settings.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Save settings
      </Button>
      {message ? <p role="status">{message}</p> : null}

      <section
        className="fdy-device-removal-zone"
        aria-labelledby="fdy-device-removal-heading"
      >
        <h3 id="fdy-device-removal-heading">Remove device</h3>
        <p>
          Unregister {device.label} from this Foundry server. Its workspaces
          leave the available lists; chats, issues and run history are kept.
          Nothing on the machine is deleted.
        </p>
        <Button size="sm" variant="ghost" onClick={onRemoveDevice}>
          Remove from Foundry…
        </Button>
      </section>
    </section>
  );
}
