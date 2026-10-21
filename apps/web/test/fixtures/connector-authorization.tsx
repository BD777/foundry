/** Synthetic browser fixture. All API requests are intercepted; no provider or credential access. */
import { createRoot } from "react-dom/client";
import { useState, StrictMode } from "react";
import { i18n } from "../../src/i18n/index";
import "../../src/styles.css";
import { WorkspaceConnectorsFeature } from "../../src/features/external-accounts";
import { Button } from "../../src/components/ui/button";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "signed_out";
const extra = scenario.startsWith("capability");
let additionalReady = false;
let activeGroup = false;
const descriptor = {
  kind: "bytedcli",
  label: "bytedcli",
  holding: "device_held",
  adapter: "bytedcli",
  tool: { command: "bytedcli", source: "npm", package: "fixture" },
  ...(extra
    ? {
        authorizationGroups: [
          {
            id: "web_session",
            revision: 1,
            label: "Meego Web session",
            labels: { "zh-CN": "Meego 网页会话", en: "Meego Web session" },
            capabilities: ["fixture_one", "fixture_two"],
            credential: "native_web_session",
          },
        ],
      }
    : {}),
};
let signedIn = scenario === "ready" || extra;
let bindings: object[] = extra
  ? [
      {
        workspaceId: "fixture-workspace",
        deviceId: "fixture-mac",
        kind: "bytedcli",
        members: false,
        grantedBy: "fixture-user",
        createdAt: new Date().toISOString(),
      },
    ]
  : [];
let polls = 0;
let begins = 0;
let saves = 0;
let active = "";
let slowPhase = 0;
const requests = new Map<string, string>();
Object.assign(window, {
  connectorFixturePhase: (value: number) => {
    slowPhase = value;
  },
  connectorFixtureStats: () => ({
    begins,
    polls,
    active,
    requests: requests.size,
  }),
});
const state = () => ({
  deviceId: "fixture-mac",
  kind: "bytedcli",
  status: signedIn
    ? "ready"
    : scenario === "offline"
      ? "signed_out"
      : scenario === "unavailable"
        ? "unavailable"
        : "signed_out",
  installed: true,
  signedIn,
  identity: signedIn ? "fixture-user" : undefined,
  sites: ["cn"],
  checkedAt: new Date().toISOString(),
  ...(extra
    ? {
        authorizations: [
          {
            id: "web_session",
            revision: 1,
            status: additionalReady ? "ready" : "needs_auth",
            checkedAt: new Date().toISOString(),
            verification: "local_state",
          },
        ],
      }
    : {}),
});
const view = () => ({
  workspaceId: "fixture-workspace",
  defaultDeviceId: "fixture-mac",
  executionDevices: [{ deviceId: "fixture-mac", name: "MacBook" }],
  connectors: [descriptor],
  bindings,
  devices: [
    {
      deviceId: "fixture-mac",
      name: "MacBook",
      online: scenario !== "offline",
      supported: true,
      authorizationSupported: scenario !== "capability_old_worker",
      states: [state()],
    },
    {
      deviceId: "unrelated-device",
      name: "Other device must stay hidden",
      online: true,
      supported: true,
      states: [{ ...state(), deviceId: "unrelated-device" }],
    },
  ],
});
window.fetch = async (input, init = {}) => {
  const path = new URL(String(input), location.origin).pathname;
  let body: unknown;
  let status = 200;
  if (path.endsWith("/external-accounts"))
    body = { workspaceId: "fixture-workspace", bindings: [], accounts: [] };
  else if (path.endsWith("/device-connectors")) {
    if (init.method === "PUT") {
      saves++;
      if (scenario === "binding_failure" && saves === 1) {
        status = 503;
        body = {
          error: "Fixture: binding save failed; login remains on the device",
        };
      } else {
        bindings = JSON.parse(String(init.body)).bindings.map((b: object) => ({
          ...b,
          workspaceId: "fixture-workspace",
          grantedBy: "fixture-user",
          createdAt: new Date().toISOString(),
        }));
        body = view();
      }
    } else body = view();
  } else if (path.endsWith("/sign-in")) {
    const requestId = JSON.parse(String(init.body)).requestId;
    if (!requests.has(requestId)) {
      begins++;
      requests.set(requestId, `fixture-operation-${begins}`);
      polls = 0;
    }
    active = requests.get(requestId)!;
    activeGroup = Boolean(JSON.parse(String(init.body)).authorizationId);
    body =
      signedIn && !activeGroup
        ? { status: "complete", operationId: active, state: state() }
        : {
            status: "pending",
            operationId: active,
            ...(activeGroup
              ? {
                  challenge: {
                    kind: "qr_image",
                    imageUrl: `/api/devices/fixture-mac/connectors/bytedcli/sign-in/image?operationId=${active}&authorizationId=web_session&authorizationRevision=1`,
                  },
                }
              : {
                  verificationUrl:
                    "https://authorization.example.invalid/approve?fixture=1",
                }),
            expiresAt: new Date(
              Date.now() +
                ((scenario === "expired" ||
                  scenario === "capability_expired") &&
                begins === 1
                  ? 1500
                  : 600_000),
            ).toISOString(),
            intervalSeconds: 2,
          };
    if (scenario === "capability_slow")
      body = {
        status: "pending",
        phase: "checking",
        operationId: active,
        intervalSeconds: 2,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
  } else if (path.endsWith("/sign-in/poll")) {
    polls++;
    if (JSON.parse(String(init.body)).operationId !== active) {
      status = 409;
      body = { error: "Stale operation" };
    } else if (
      (scenario === "denied" || scenario === "capability_denied") &&
      begins === 1
    )
      body = { status: "denied", operationId: active };
    else if (scenario === "disconnect" && polls === 1) {
      status = 503;
      body = { error: "Fixture device temporarily offline" };
    } else if (scenario === "capability_slow" && slowPhase < 6) {
      if (slowPhase === 3) {
        status = 503;
        body = { error: "Fixture connection dropped after dispatch" };
      } else
        body = {
          status: "pending",
          operationId: active,
          phase:
            slowPhase === 0
              ? "checking"
              : slowPhase === 1
                ? "starting"
                : slowPhase === 5
                  ? "verifying"
                  : "awaiting_user",
          ...(slowPhase === 2 || slowPhase === 4
            ? {
                challenge: {
                  kind: "qr_image",
                  imageUrl: `/api/devices/fixture-mac/connectors/bytedcli/sign-in/image?operationId=${active}`,
                },
              }
            : {}),
        };
    } else if (polls < 3) body = { status: "pending", operationId: active };
    else {
      signedIn = true;
      if (activeGroup) additionalReady = true;
      body = { status: "complete", operationId: active, state: state() };
    }
  } else if (path.endsWith("/sign-in/dismiss")) {
    body = {};
  } else if (path.endsWith("/check")) body = state();
  else {
    status = 404;
    body = { error: `Unconfigured fixture endpoint: ${path}` };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};
function Fixture() {
  const [notice, setNotice] = useState("");
  return (
    <main
      className="fdy-page-surface"
      style={{ maxWidth: 1000, margin: "auto", padding: 24 }}
    >
      <h1>Workspace · Connectors</h1>
      <p>Isolated fixture · MacBook</p>
      <Button
        onClick={() =>
          (document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === "dark"
              ? "light"
              : "dark")
        }
      >
        Theme
      </Button>
      <WorkspaceConnectorsFeature
        workspaceId="fixture-workspace"
        currentUserId="fixture-user"
        onNotice={setNotice}
      />
      <p role="status">{notice}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
