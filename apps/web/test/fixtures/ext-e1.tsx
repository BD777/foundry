/** Synthetic connector states for E1 screenshots; no request leaves this page. */
import { createRoot } from "react-dom/client";
import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
} from "@bd777/foundry-protocol";
import { i18n } from "../../src/i18n/index";
import "../../src/styles.css";
import { ConnectorsFeature } from "../../src/features/external-accounts";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";

const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const scene = params.get("scene") ?? "picker";
let installed = false;
let autoUpdate = true;

const signal: ConnectorDescriptor = {
  kind: "signal",
  label: "Signal docs",
  description: "Read the product source without exposing its repository URL.",
  holding: "device_held",
  adapter: "extension:signal",
  tool: { command: "signal", source: "device" },
  extension: {
    id: "signal",
    name: "Signal tools",
    version: "1.4.0",
    bundled: true,
    state: "installed",
  },
  signIn: {
    methods: [{ id: "terminal", kind: "terminal", label: "In a terminal" }],
  },
};

const archive: ConnectorDescriptor = {
  kind: "archive",
  label: "Archive tools",
  description: "Search the team archive with this device's own login.",
  holding: "device_held",
  adapter: "extension:archive",
  tool: { command: "archive", source: "device" },
  extension: {
    id: "archive",
    name: "Archive tools",
    version: "2.3.1",
    state: "installed",
    source: {
      git: "https://example.com/team/archive.git",
      path: "extensions/archive",
    },
    commit: "a".repeat(40),
    latestCommit: "b".repeat(40),
    autoUpdate: true,
  },
  signIn: {
    methods: [{ id: "terminal", kind: "terminal", label: "In a terminal" }],
  },
};

const orbit: ConnectorDescriptor = {
  kind: "orbit",
  label: "Orbit",
  description: "Read the Orbit source and deployment metadata.",
  holding: "device_held",
  adapter: "extension:orbit",
  tool: { command: "orbit", source: "device" },
  extension: {
    id: "orbit",
    name: "Orbit tools",
    version: "1.0.0",
    bundled: true,
    state: installed ? "installed" : "available",
  },
  access: {
    via: "github",
    repository: "example/orbit",
    hint: "GitHub CLI must be able to read example/orbit.",
  },
  requires: [
    {
      kind: "tcp_reachable",
      host: "orbit.internal.example",
      port: 443,
      label: "Orbit network",
    },
  ],
  signIn: {
    methods: [{ id: "terminal", kind: "terminal", label: "In a terminal" }],
  },
};

const restricted = {
  connector: orbit,
  devices: [
    {
      deviceId: "dev_mac",
      name: "MacBook Pro",
      online: true,
      viaLabel: "GitHub CLI",
      requirementsCheck: {
        ok: false,
        requirement: "Orbit network",
        checkedAt: iso(-120_000),
      },
      accessCheck: {
        via: "github",
        status: "no_access",
        identity: "alex",
        checkedAt: iso(-120_000),
      },
    },
    {
      deviceId: "dev_ci",
      name: "Linux runner",
      online: true,
      viaLabel: "GitHub CLI",
      requirementsCheck: {
        ok: true,
        checkedAt: iso(-120_000),
      },
      accessCheck: {
        via: "github",
        status: "not_signed_in",
        checkedAt: iso(-120_000),
      },
    },
  ],
};

function device(
  descriptor: ConnectorDescriptor,
  overrides: Partial<DeviceConnectorDevice> = {},
): DeviceConnectorDevice {
  const extension = descriptor.extension;
  return {
    deviceId: "dev_mac",
    name: "MacBook Pro",
    online: true,
    extensionKinds:
      extension && extension.state !== "available" ? [descriptor.kind] : [],
    extensions: extension
      ? [
          {
            ...extension,
            ...(descriptor.kind === "archive" ? { autoUpdate } : {}),
          },
        ]
      : [],
    states:
      extension && extension.state !== "available"
        ? [
            {
              deviceId: "dev_mac",
              kind: descriptor.kind,
              status: descriptor.kind === "archive" ? "ready" : "signed_out",
              installed: true,
              signedIn: descriptor.kind === "archive",
              identity: descriptor.kind === "archive" ? "alex" : undefined,
              version: extension.version,
              checkedAt: iso(-60_000),
            },
          ]
        : [],
    ...overrides,
  };
}

const feishu: ConnectorDescriptor = {
  kind: "feishu",
  label: "Feishu",
  holding: "server_held",
  adapter: "feishu",
  tool: { command: "feishu-cli" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.origin);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/api/connectors") {
    if (scene === "picker")
      return json({
        connectors: [feishu, signal],
        restrictedConnectors: [restricted],
      });
    return json({ connectors: [scene === "auto" ? archive : orbit] });
  }
  if (method === "GET" && url.pathname === "/api/connectors/devices") {
    if (scene === "picker")
      return json({ connectors: [feishu, signal], devices: [device(signal)] });
    if (scene === "auto")
      return json({ connectors: [archive], devices: [device(archive)] });
    return json({
      connectors: [orbit],
      devices: [
        device(orbit),
        device(orbit, {
          deviceId: "dev_office",
          name: "Office PC",
          online: false,
          extensions: [orbit.extension!],
        }),
      ],
    });
  }
  if (method === "GET" && url.pathname === "/api/external-accounts")
    return json({
      accounts: [],
      apps: [],
      providers: [],
      secretsConfigured: true,
    });
  if (method === "POST" && url.pathname === "/api/devices/dev_mac/extensions") {
    installed = true;
    return json({
      action: "created",
      extension: {
        id: "orbit",
        name: "Orbit tools",
        version: "1.0.0",
        connectors: ["orbit"],
        bundled: true,
        state: "installed",
      },
    });
  }
  if (
    method === "PATCH" &&
    url.pathname === "/api/devices/dev_mac/extensions/archive"
  ) {
    autoUpdate = JSON.parse(String(init.body)).autoUpdate;
    return json({
      action: "updated",
      extension: {
        ...archive.extension,
        autoUpdate,
      },
    });
  }
  if (method === "POST" && url.pathname === "/api/connectors/recheck-access")
    return json({ connectors: [feishu, signal], restrictedConnectors: [] });
  return json({ error: `no fixture route ${method} ${url.pathname}` }, 404);
};

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-canvas px-5 py-6">
    <ConnectorsFeature
      currentUserId="user_fixture"
      isAdmin={false}
      onNotice={() => undefined}
      onTabChange={() => undefined}
      tab={
        scene === "auto" ? "archive" : scene === "install" ? "orbit" : "signal"
      }
    />
  </div>,
);
