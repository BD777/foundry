import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { i18n } from "../../src/i18n";
import {
  ConnectorsFeature,
  WorkspaceConnectorsFeature,
} from "../../src/features/external-accounts";
const query = new URLSearchParams(location.search);
void i18n.changeLanguage(query.get("lang") || "en");
document.documentElement.dataset.theme = query.get("theme") || "light";
const connector = {
  kind: "aws",
  label: "AWS CLI",
  holding: "device_held",
  adapter: "aws",
  tool: { command: "aws", source: "device" },
  authentication: "local",
};
const deviceId = "dev_aws_fixture";
let bindings: unknown[] = [];
let checks = 0;
const status = query.get("status") || "ready";
const state = () => ({
  deviceId,
  kind: "aws",
  status,
  installed: status !== "not_installed",
  signedIn: status === "ready",
  identity:
    status === "ready" ? "arn:aws:iam::123456789012:role/Developer" : undefined,
  version: "2.38.2",
  installSource: "device",
  checkedAt: new Date().toISOString(),
  statusDetail:
    status === "error"
      ? "AWS identity check failed. Check the device network and retry."
      : undefined,
});
const devices = () => [
  {
    deviceId,
    name: "AWS development device",
    online: query.get("offline") !== "1",
    supported: true,
    states: [state()],
  },
];
Object.assign(window, { awsFixtureStats: () => ({ checks, bindings }) });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path.endsWith("/check")) {
    checks++;
    await new Promise((r) => setTimeout(r, 600));
    return Response.json(state());
  }
  if (path.endsWith("/device-connectors")) {
    if (init?.method === "PUT")
      bindings = JSON.parse(String(init.body)).bindings.map((b: object) => ({
        ...b,
        workspaceId: "ws_fixture",
        grantedBy: "user_fixture",
        deviceName: "AWS development device",
        createdAt: new Date().toISOString(),
        state: state(),
      }));
    return Response.json({
      workspaceId: "ws_fixture",
      connectors: [connector],
      devices: devices(),
      bindings,
      defaultDeviceId: deviceId,
      executionDevices: [{ deviceId, name: "AWS development device" }],
    });
  }
  if (path.endsWith("/connectors/devices"))
    return Response.json({ connectors: [connector], devices: devices() });
  if (path.endsWith("/external-accounts"))
    return Response.json({ accounts: [], bindings: [], apps: [] });
  if (path.endsWith("/external-account-bindings"))
    return Response.json({ bindings: [] });
  if (path.includes("cloudflare"))
    return Response.json({ accounts: [], bindings: [] });
  return Response.json({ accounts: [], bindings: [], apps: [] });
};
function Fixture() {
  const [notice, setNotice] = useState("");
  return (
    <main style={{ maxWidth: 1000, margin: "auto", padding: 24 }}>
      {query.has("workspace") ? (
        <WorkspaceConnectorsFeature
          workspaceId="ws_fixture"
          currentUserId="user_fixture"
          onNotice={setNotice}
        />
      ) : (
        <ConnectorsFeature
          tab="aws"
          currentUserId="user_fixture"
          isAdmin={false}
          onNotice={setNotice}
          onTabChange={() => {}}
        />
      )}
      <p role="status">{notice}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
