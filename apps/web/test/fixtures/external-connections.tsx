/** Synthetic API and the real DeviceProviders; never touches a real device. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import "../../src/styles.css";
import { i18n } from "../../src/i18n";
import { DeviceProviders } from "../../src/features/devices/device-providers";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
// scenario: ready (default) | old-worker | offline | not-owner
const scenario = params.get("scenario") || "ready";
const delay = Number(params.get("delay") || 1200);
const device = {
  id: "fixture",
  label: "Connection test device",
  status: scenario === "offline" ? "disconnected" : "connected",
  owned: scenario !== "not-owner",
  capabilities:
    scenario === "old-worker" ? [] : ["external_connection_manage_v1"],
} as unknown as DeviceProjection;
const base = {
  deviceId: device.id,
  origin: "device",
  runtime: "claude",
  configScope: "device",
  configLabel: "~/.foundry/agent-profiles.local.json",
  connectionType: "external",
  status: "healthy",
  model: "sonnet",
  check: { status: "passed", checkedAt: "2026-10-26T07:07:26Z" },
};
const initial = [
  { ...base, id: "external", label: "External connection" },
  {
    ...base,
    id: "api",
    label: "API connection",
    connectionType: "anthropic_compatible",
    baseUrl: "https://example.invalid",
  },
  {
    ...base,
    id: "pending",
    label: "Unchecked connection",
    status: "unavailable",
    check: { status: "pending" },
  },
  {
    ...base,
    id: "failed",
    label: "Failing connection",
    status: "unavailable",
    check: {
      status: "failed",
      checkedAt: "2026-10-26T06:00:00Z",
      message: "The gateway refused the synthetic account.",
    },
  },
  {
    ...base,
    id: "missing",
    label: "Missing helper connection",
    status: "unavailable",
    statusDetail: "External connection helper is unavailable on this device.",
    check: undefined,
  },
] as AgentProfileProjection[];

let profiles = initial;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
// Check passes for "pending", fails for "failed", and the device is busy
// for "external"; removing "failed" is refused, others succeed.
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const match = url.match(/external-connections\/([^/]+)(\/check)?$/);
  if (!match) return json(404, { error: "not in fixture" });
  await new Promise((resolve) => setTimeout(resolve, delay));
  const id = decodeURIComponent(match[1]!);
  const now = new Date().toISOString();
  if (match[2]) {
    if (id === "external")
      return json(409, {
        error: "External connection is already being checked.",
      });
    const passed = id === "pending";
    profiles = profiles.map((row) =>
      row.id !== id
        ? row
        : passed
          ? {
              ...row,
              status: "healthy",
              check: { status: "passed", checkedAt: now },
            }
          : {
              ...row,
              check: {
                status: "failed",
                checkedAt: now,
                message: "The gateway refused the synthetic account.",
              },
            },
    );
    return json(
      200,
      passed
        ? { status: "passed", checkedAt: now }
        : {
            status: "failed",
            checkedAt: now,
            message: "The gateway refused the synthetic account.",
          },
    );
  }
  if (init?.method === "DELETE" && id === "failed")
    return json(502, { error: "Synthetic device error while removing." });
  profiles = profiles.filter((row) => row.id !== id);
  return json(200, { removed: true, profileId: id });
};

function Fixture() {
  const [rows, setRows] = useState(profiles);
  return (
    <main style={{ maxWidth: 1000, margin: "auto", padding: 24 }}>
      <DeviceProviders
        device={device}
        profiles={rows}
        serverProfiles={[]}
        onRefresh={async () => setRows(profiles)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
