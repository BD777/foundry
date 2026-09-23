import { useRef, useState } from "react";
import { KeyRound, Monitor, Network } from "lucide-react";
import type { DevicesFeatureProps } from "./devices-feature";
import type {
  DeviceProjection,
  AgentProfileProjection,
} from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import { DeviceAccounts } from "./device-accounts";
import { DeviceConnections } from "./device-connections";
import { isModelConnection } from "../../lib/model-connections";

export function DeviceAccess({
  device,
  ownProfiles,
  ...props
}: DevicesFeatureProps & {
  device: DeviceProjection;
  ownProfiles: AgentProfileProjection[];
}) {
  const [source, setSource] = useState<"accounts" | "connections">("accounts");
  const accountsTab = useRef<HTMLButtonElement>(null);
  const connectionsTab = useRef<HTMLButtonElement>(null);
  const count = props.deviceProfiles.filter(
    (binding) =>
      binding.deviceId === device.id &&
      binding.enabled &&
      props.profiles.some(
        (profile) =>
          profile.id === binding.profileId && isModelConnection(profile),
      ),
  ).length;
  return (
    <section className="fdy-device-access">
      <div className="fdy-access-intro">
        <h2>How this device connects to AI</h2>
        <p>
          Choose an account or API connection when starting a chat. Both run on{" "}
          <strong>{device.label}</strong>.
        </p>
      </div>
      <div
        className="fdy-access-tabs"
        role="tablist"
        aria-label="AI access sources"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "accounts"
              : event.key === "End"
                ? "connections"
                : source === "accounts"
                  ? "connections"
                  : "accounts";
          setSource(next);
          (next === "accounts" ? accountsTab : connectionsTab).current?.focus();
        }}
      >
        <Button
          ref={accountsTab}
          tabIndex={source === "accounts" ? 0 : -1}
          role="tab"
          aria-selected={source === "accounts"}
          aria-controls="device-accounts-panel"
          id="device-accounts-tab"
          variant="ghost"
          className="fdy-access-tab"
          onClick={() => setSource("accounts")}
        >
          <Monitor size={18} />
          <span>
            <strong>Official accounts</strong>
            <small>Sign in separately on this device</small>
          </span>
        </Button>
        <Button
          ref={connectionsTab}
          tabIndex={source === "connections" ? 0 : -1}
          role="tab"
          aria-selected={source === "connections"}
          aria-controls="device-connections-panel"
          id="device-connections-tab"
          variant="ghost"
          className="fdy-access-tab"
          onClick={() => setSource("connections")}
        >
          <Network size={18} />
          <span>
            <strong>
              Server API connections <em>{count}</em>
            </strong>
            <small>Shared configuration · Explicit device access</small>
          </span>
        </Button>
      </div>
      <div
        role="tabpanel"
        id={
          source === "accounts"
            ? "device-accounts-panel"
            : "device-connections-panel"
        }
        aria-labelledby={
          source === "accounts"
            ? "device-accounts-tab"
            : "device-connections-tab"
        }
      >
        {source === "accounts" ? (
          <>
            <p className="fdy-access-explanation">
              <KeyRound size={14} /> Use your ChatGPT or Claude subscription.
              Credentials stay on this device; no server connection is needed.
            </p>
            <DeviceAccounts
              device={device}
              profiles={ownProfiles}
              health={props.providerHealth.filter(
                (row) => row.deviceId === device.id,
              )}
              legacyProfiles={props.profiles}
              bindings={props.deviceProfiles}
              onRefresh={props.onRefresh}
            />
          </>
        ) : (
          <DeviceConnections
            device={device}
            profiles={props.profiles}
            bindings={props.deviceProfiles}
            detected={ownProfiles.filter((row) => row.origin === "device")}
            onRefresh={props.onRefresh}
            onManage={props.onManageConnections}
          />
        )}
      </div>
    </section>
  );
}
