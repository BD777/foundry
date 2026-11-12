/** Isolated synthetic server-held extension fixture. No request leaves the browser. */
import { createRoot } from "react-dom/client";
import type {
  ConnectorDescriptor,
  ConnectorServerHeldInstance,
} from "@bd777/foundry-protocol";
import { i18n } from "../../src/i18n/index";
import "../../src/styles.css";
import { ConnectorsFeature } from "../../src/features/external-accounts";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";

const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const account = {
  id: "xacc_acme",
  provider: "acme-api",
  appId: "app_acme",
  ownerUserId: "fixture-owner",
  label: "Production",
  displayName: "Production",
  mode: "server_held",
  status: "ready",
  workspaceIds: ["ws_fixture"],
  createdAt: iso(-7 * 86_400_000),
  updatedAt: iso(-120_000),
};
const fieldOptions = {
  account: [
    { value: "primary", label: "Primary account" },
    { value: "research", label: "Research account" },
  ],
};
const descriptor: ConnectorDescriptor = {
  kind: "acme-api",
  label: "Acme API",
  labels: { "zh-CN": "Acme API" },
  description: "Read Acme projects through Foundry's server-held gateway.",
  descriptions: {
    "zh-CN": "经 Foundry 的服务器保管网关读取 Acme 项目。",
  },
  holding: "server_held",
  adapter: "extension:acme",
  tool: { command: "acme", source: "device" },
  extension: { id: "acme", name: "Acme tools", version: "1.0.0" },
  serverHeld: {
    instances: "many",
    fields: [
      {
        id: "baseUrl",
        type: "url",
        required: true,
        label: "Acme HTTPS address",
        labels: { "zh-CN": "Acme HTTPS 地址" },
        help: "Use the public HTTPS root. Read [the setup guide](https://docs.acme.example) before generating an `ACME_READ_TOKEN`.",
        helps: {
          "zh-CN":
            "填写对外可访问的 HTTPS 根地址。生成 `ACME_READ_TOKEN` 前请先阅读[配置指南](https://docs.acme.example)。",
        },
        placeholder: "https://acme.example.com",
      },
      {
        id: "readToken",
        type: "secret",
        required: true,
        label: "Read token",
        labels: { "zh-CN": "只读令牌" },
        help: "Run `acme token create --read` on the server, then paste the value here. Foundry seals it on the server.",
        helps: {
          "zh-CN":
            "在 Acme 服务器运行 `acme token create --read`，然后把值填到这里。Foundry 会将它封存在服务器上。",
        },
        placeholder: "ACME_READ_TOKEN",
      },
      {
        id: "account",
        type: "select",
        required: false,
        label: "Project account",
        labels: { "zh-CN": "项目账号" },
        help: "Leave empty for the primary account, or choose one after validation.",
        helps: {
          "zh-CN": "留空使用主账号，或在校验通过后选择一个账号。",
        },
        optionsFrom: "probe:accounts",
      },
    ],
    steps: [["baseUrl", "readToken"], ["account"]],
    probe: [
      {
        id: "accounts",
        method: "GET",
        path: "/v1/accounts",
        extract: {
          values: { version: "/version" },
          options: {
            items: "/accounts",
            value: "/id",
            label: "/name",
          },
        },
      },
      {
        id: "routes",
        method: "GET",
        path: "/v1/",
        extract: {
          routes: {
            items: "/routes",
            method: "/method",
            path: "/path",
            access: "/access",
          },
        },
      },
    ],
    upstream: {
      baseField: "baseUrl",
      pathPrefix: "/v1",
      headers: { Authorization: "Bearer {secret:readToken}" },
    },
    access: {
      from: "probe:routes",
      default: "deny",
      allow: ["read"],
    },
    session: {
      env: {
        ACME_API_BASE: "{gatewayBase}",
        ACME_API_TOKEN: "{standIn}",
      },
    },
    network: { holdings: ["server", "device"], publicOnly: true },
  },
};
let instances: ConnectorServerHeldInstance[] = [
  {
    id: "inst_prod",
    accountId: "xacc_acme",
    kind: "acme-api",
    label: "Production",
    network: "server",
    status: "ready",
    statusDetail: "ok",
    version: "2026.11",
    routeCount: 6,
    values: { baseUrl: "https://acme.example.com", account: "primary" },
    secretFields: ["readToken"],
    fieldOptions,
    probeValues: { version: "2026.11" },
    createdAt: iso(-7 * 86_400_000),
    updatedAt: iso(-120_000),
  },
  {
    id: "inst_staging",
    accountId: "xacc_acme_staging",
    kind: "acme-api",
    label: "Staging",
    network: "device",
    probeDeviceId: "dev_byte",
    availableDevices: [
      {
        deviceId: "dev_byte",
        name: "byte-dev",
        status: "ok",
        checkedAt: iso(-86_400_000),
      },
      {
        deviceId: "dev_mac",
        name: "alice-mac",
        status: "ok",
        checkedAt: iso(-86_400_000),
      },
      {
        deviceId: "dev_nas",
        name: "alice-nas",
        status: "unreachable",
        checkedAt: iso(-86_400_000),
        detail: "Foundry could not reach the connector server",
      },
    ],
    status: "needs_reauth",
    statusDetail: "unauthorized: the connector rejected the credential",
    version: "2026.10",
    routeCount: 6,
    values: {
      baseUrl: "https://staging.acme.example",
      account: "research",
    },
    secretFields: ["readToken"],
    fieldOptions,
    probeValues: { version: "2026.10" },
    createdAt: iso(-14 * 86_400_000),
    updatedAt: iso(-86_400_000),
  },
];
const probeResult = {
  values: {
    baseUrl: "https://staging.acme.example",
  },
  secretFields: ["readToken"],
  probeValues: { version: "2026.11" },
  fieldOptions,
  version: "2026.11",
  routeCount: 6,
};
const devices = [
  { deviceId: "dev_byte", name: "byte-dev", online: true },
  { deviceId: "dev_office", name: "Office NAS", online: false },
];

const deviceChecks = (probeDeviceId: string, baseUrl: string) => {
  const probeName =
    devices.find((device) => device.deviceId === probeDeviceId)?.name ??
    probeDeviceId;
  const checkedAt = iso();
  const loopback = /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
  return [
    { deviceId: probeDeviceId, name: probeName, status: "ok", checkedAt },
    ...(loopback
      ? [
          {
            deviceId: "dev_mac",
            name: "alice-mac",
            status: "not_applicable",
            checkedAt,
            detail: `This address only works on ${probeName}.`,
          },
        ]
      : [
          { deviceId: "dev_mac", name: "alice-mac", status: "ok", checkedAt },
          {
            deviceId: "dev_nas",
            name: "alice-nas",
            status: "unreachable",
            checkedAt,
            detail: "Foundry could not reach the connector server",
          },
        ]),
  ];
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

window.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.origin);
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  if (method === "GET" && url.pathname === "/api/connectors")
    return json({
      connectors: [
        {
          kind: "feishu",
          label: "Feishu",
          holding: "server_held",
          adapter: "feishu",
          tool: { command: "feishu-cli" },
        },
        descriptor,
      ],
    });
  if (method === "GET" && url.pathname === "/api/connectors/devices")
    return json({ connectors: [], devices: [] });
  if (method === "GET" && url.pathname === "/api/external-accounts")
    return json({
      accounts: [account],
      apps: [],
      providers: [],
      secretsConfigured: true,
    });
  if (
    method === "GET" &&
    url.pathname === "/api/connectors/extensions/acme-api/instances"
  )
    return json({ kind: "acme-api", descriptor, instances, devices });
  if (
    method === "POST" &&
    url.pathname === "/api/connectors/extensions/acme-api/instances/probe"
  )
    return json(
      body.network === "device"
        ? {
            ...probeResult,
            network: "device",
            probeDeviceId: body.deviceId,
            availableDevices: deviceChecks(
              body.deviceId,
              String(body.fields?.baseUrl ?? ""),
            ),
          }
        : probeResult,
    );
  if (
    method === "POST" &&
    url.pathname === "/api/connectors/extensions/acme-api/instances"
  ) {
    const created: ConnectorServerHeldInstance = {
      id: "inst_fixture_new",
      accountId: "xacc_fixture_new",
      kind: "acme-api",
      label: body.label || "Staging",
      network: body.network,
      ...(body.network === "device"
        ? {
            probeDeviceId: body.deviceId,
            availableDevices: deviceChecks(
              body.deviceId,
              String(body.fields?.baseUrl ?? ""),
            ),
          }
        : {}),
      status: "ready",
      statusDetail: "ok",
      version: "2026.11",
      routeCount: 6,
      values: body.fields,
      secretFields: ["readToken"],
      fieldOptions,
      probeValues: { version: "2026.11" },
      createdAt: iso(),
      updatedAt: iso(),
    };
    instances = [created, ...instances];
    return json(created, 201);
  }
  const prefix = "/api/connectors/extensions/acme-api/instances/";
  if (url.pathname.startsWith(prefix)) {
    const id = decodeURIComponent(
      url.pathname.slice(prefix.length).split("/")[0] ?? "",
    );
    const found = instances.find((instance) => instance.id === id);
    if (!found) return json({ error: "fixture instance not found" }, 404);
    if (method === "POST" && url.pathname.endsWith("/check")) {
      found.status = "ready";
      found.statusDetail = "ok";
      found.updatedAt = iso();
      return json(found);
    }
    if (method === "PUT") {
      found.label = body.label || found.label;
      found.values = body.fields;
      found.status = "ready";
      found.statusDetail = "ok";
      found.updatedAt = iso();
      return json(found);
    }
    if (method === "DELETE") {
      found.status = "revoked";
      found.statusDetail = "revoked";
      found.updatedAt = iso();
      return json(found);
    }
  }
  return json(
    { error: `Unconfigured fixture endpoint: ${method} ${url.pathname}` },
    404,
  );
};

createRoot(document.getElementById("root")!).render(
  <ConnectorsFeature
    currentUserId="fixture-owner"
    isAdmin={false}
    onNotice={(message) => {
      document.body.dataset.notice = message;
    }}
    onTabChange={() => undefined}
    tab="acme-api"
  />,
);
