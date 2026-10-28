/** Synthetic API and real Devices feature; never changes a real device. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import "./device-account-share.css";
import { DevicesFeature } from "../../src/features/devices";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import type { DeviceSection } from "../../src/features/devices";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "pending";
const shares = (name: string) => [
  {
    deviceId: "shared-" + name,
    deviceLabel: "Shared device",
    ownerName: name,
    noticePending: scenario !== "read",
    acceptedAt: "2026-10-20T00:00:00Z",
    acceptedBy: name,
  },
];
const initial: DeviceProjection[] = [
  {
    id: "device-a",
    label: "linux-dev",
    status: "connected",
    lastSeenLabel: "online",
    owned: true,
    sharesSystemAccountWith:
      scenario === "none"
        ? []
        : scenario === "long"
          ? Array.from({ length: 5 }, (_, i) => ({
              deviceId: "shared-" + i,
              deviceLabel: "Shared device",
              ownerName: ("SharedMemberWithLongName" + i).repeat(3),
              noticePending: true,
            }))
          : shares("e2e-alice"),
  },
  {
    id: "device-b",
    label: scenario === "same" ? "linux-dev" : "dev-server",
    status: "disconnected",
    lastSeenLabel: "offline",
    owned: true,
    sharesSystemAccountWith:
      scenario === "none" ? [] : shares("Another person"),
  },
  {
    id: "device-c",
    label: "Unshared computer",
    status: "connected",
    lastSeenLabel: "online",
    owned: true,
  },
];
const calls: string[] = [];
(window as unknown as { shareCalls: string[] }).shareCalls = calls;
let dismissed = new Set<string>();
window.fetch = async (input, init) => {
  const url = String(input);
  if (init?.method === "POST") {
    calls.push(url);
    if (scenario === "slow") await new Promise((r) => setTimeout(r, 1500));
    if (scenario === "error")
      return new Response(
        JSON.stringify({ error: "Synthetic acknowledgment error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    const id = /devices\/([^/]+)\/system-account-notice/.exec(url)?.[1];
    if (id) dismissed.add(id);
    return new Response(null, { status: 204 });
  }
  return new Response(
    JSON.stringify(url.includes("/worker-release") ? {} : []),
    { headers: { "Content-Type": "application/json" } },
  );
};
class FixtureEvents {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.defineProperty(window, "EventSource", { value: FixtureEvents });
function App() {
  const [devices, setDevices] = useState(initial);
  const [selected, setSelected] = useState<string | undefined>(
    params.get("device") ?? undefined,
  );
  const [section, setSection] = useState<DeviceSection>("agents");
  return (
    <main className="device-share-fixture">
      <DevicesFeature
        devices={devices}
        activeWorkspaceId=""
        selectedDeviceId={selected}
        section={section}
        onSelect={(id, next) => {
          setSelected(id);
          if (next) setSection(next);
        }}
        workspaces={[]}
        profiles={[]}
        agentProfiles={[]}
        deviceProfiles={[]}
        deviceSkillRoots={[]}
        providerHealth={[]}
        onOpenWorkspace={async () => true}
        onOpenWorkspaces={() => {}}
        onManageConnections={() => {}}
        onRefresh={async () => {
          setDevices((current) =>
            current.map((d) =>
              dismissed.has(d.id)
                ? {
                    ...d,
                    sharesSystemAccountWith: d.sharesSystemAccountWith?.map(
                      (s) => ({ ...s, noticePending: false }),
                    ),
                  }
                : d,
            ),
          );
        }}
      />
      <output data-testid="selected-device">{selected ?? "list"}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
