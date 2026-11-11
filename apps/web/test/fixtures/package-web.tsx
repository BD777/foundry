/** Synthetic connector package and Skill Library; no request leaves the browser. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type {
  ConnectorDescriptor,
  ConnectorPackageView,
  DeviceProjection,
  PromotedSkill,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import { ConnectorsFeature } from "../../src/features/external-accounts";
import { SkillLibraryFeature } from "../../src/features/skill-library";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";

const connector: ConnectorDescriptor = {
  kind: "openlark",
  label: "OpenLark",
  labels: { "zh-CN": "OpenLark" },
  holding: "server_held",
  adapter: "extension:openlark",
  description: "Feishu/Lark CLI and Skills that follow one upstream version.",
  descriptions: {
    "zh-CN": "同一上游版本发布的飞书/Lark CLI 与 Skill。",
  },
  tool: { command: "olk", source: "device" },
  extension: { id: "openlark", name: "OpenLark", version: "1.0.0" },
  package: {
    upstream: {
      via: "github",
      repository: "https://github.com/nwverse/open-lark",
      ref: "main",
    },
    skills: { path: "plugins/open-lark/skills" },
    tools: [
      {
        command: "olk",
        source: "repository",
        path: "plugins/open-lark",
        bins: { olk: "bin/olk", "olk-ctx": "bin/olk-ctx" },
      },
    ],
  },
};

const packageView: ConnectorPackageView = {
  connector,
  enabled: true,
  repositoryId: "repo_openlark",
  devices: [
    {
      deviceId: "dev_mac",
      name: "Ada's MacBook",
      online: true,
      selected: true,
      eligible: true,
    },
    {
      deviceId: "dev_linux",
      name: "Build Linux",
      online: true,
      selected: false,
      eligible: true,
    },
    {
      deviceId: "dev_offline",
      name: "Home mini",
      online: false,
      selected: false,
      eligible: false,
      reason: "The device is offline.",
    },
  ],
};

const repository: SkillRepository = {
  id: "repo_openlark",
  url: "https://github.com/nwverse/open-lark",
  label: "github.com/nwverse/open-lark",
  ref: "main",
  subpath: "plugins/open-lark/skills",
  commit: "8f31c2a9b1e4d7f6",
  checkedAt: "2026-11-11T03:20:00Z",
  createdAt: "2026-11-10T10:00:00Z",
  mode: "bundle",
  name: "OpenLark",
  version: "main@8f31c2a",
  description: "One CLI and its Feishu/Lark Skills, following the same commit.",
  skills: [
    {
      skillId: "sk_olk_docs",
      dir: "plugins/open-lark/skills/olk-docs",
      commit: "8f31c2a9b1e4d7f6",
      name: "olk-docs",
    },
    {
      skillId: "sk_olk_mail",
      dir: "plugins/open-lark/skills/olk-mail",
      commit: "8f31c2a9b1e4d7f6",
      name: "olk-mail",
    },
    {
      skillId: "sk_openlark_setup",
      dir: "plugins/open-lark/skills/setup",
      commit: "8f31c2a9b1e4d7f6",
      name: "openlark-setup",
    },
  ],
  tools: [
    {
      name: "olk",
      version: "8f31c2a",
      assets: [],
    },
  ],
  versions: [
    {
      seq: 1,
      tag: "main@8f31c2a",
      commit: "8f31c2a9b1e4d7f6",
      appliedAt: "2026-11-11T03:20:00Z",
      added: ["olk-docs", "olk-mail", "openlark-setup"],
    },
  ],
};

const devices = [
  {
    id: "dev_mac",
    label: "Ada's MacBook",
    status: "connected",
    lastSeenLabel: "now",
    owned: true,
  },
  {
    id: "dev_linux",
    label: "Build Linux",
    status: "connected",
    lastSeenLabel: "now",
    owned: true,
  },
  {
    id: "dev_offline",
    label: "Home mini",
    status: "offline",
    lastSeenLabel: "2 hours ago",
    owned: true,
  },
] as DeviceProjection[];

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
    return json({ connectors: [connector] });
  if (method === "GET" && url.pathname === "/api/connectors/devices")
    return json({ connectors: [], devices });
  if (method === "GET" && url.pathname === "/api/external-accounts")
    return json({
      accounts: [],
      apps: [],
      providers: [],
      secretsConfigured: true,
    });
  if (method === "GET" && url.pathname === "/api/connector-packages")
    return json([packageView]);
  if (
    method === "PUT" &&
    url.pathname === "/api/connector-packages/openlark/devices"
  ) {
    packageView.devices = packageView.devices.map((device) => ({
      ...device,
      selected: body.deviceIds.includes(device.deviceId),
    }));
    packageView.enabled = body.deviceIds.length > 0;
    return json(packageView);
  }
  if (method === "GET" && url.pathname === "/api/skill-repositories")
    return json([repository]);
  if (method === "GET" && url.pathname === "/api/me/default-skills")
    return json({ skillIds: ["sk_olk_docs"], bundleIds: ["repo_openlark"] });
  return json(
    { error: `Unconfigured fixture endpoint: ${method} ${url.pathname}` },
    404,
  );
};

function currentSection(): "connectors" | "library" {
  return location.pathname === "/skill-library" ? "library" : "connectors";
}

function Fixture() {
  const [section, setSection] = useState(currentSection);
  useEffect(() => {
    const read = () => setSection(currentSection());
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 max-[860px]:px-0 max-[860px]:py-0">
      {section === "library" ? (
        <SkillLibraryFeature
          canManage
          catalog={[] as PromotedSkill[]}
          devices={devices}
          deviceTools={[]}
          onChanged={async () => {}}
        />
      ) : (
        <ConnectorsFeature
          currentUserId="fixture-user"
          isAdmin
          onNotice={() => {}}
          onTabChange={() => {}}
          tab="openlark"
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
