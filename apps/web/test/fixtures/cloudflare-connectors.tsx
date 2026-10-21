/** Isolated synthetic OAuth/API fixture. No request reaches Cloudflare. */
import { createRoot } from "react-dom/client";
import { StrictMode, useState } from "react";
import { i18n } from "../../src/i18n/index";
import "../../src/styles.css";
import {
  ConnectorsFeature,
  WorkspaceConnectorsFeature,
} from "../../src/features/external-accounts";
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "auth";
const mode = params.get("mode") ?? "workspace";
const scopes = [
  "user:read",
  "account:read",
  "zone.read",
  "dns.read",
  "ssl-and-certificates.read",
];
const zone = {
  id: "a".repeat(32),
  name: "fixture.example.invalid",
  status: "active",
  type: "full",
  account: { id: "b".repeat(32), name: "Fixture Cloudflare account" },
};
const other = {
  ...zone,
  id: "c".repeat(32),
  name: "second.example.invalid",
  account: { id: "d".repeat(32), name: "Other Cloudflare account" },
};
const account = {
  id: "xacc_fixture",
  provider: "cloudflare",
  appId: "app_fixture",
  ownerUserId: "fixture-owner",
  label: "Fixture Cloudflare",
  subject: "user:fixture-cloudflare",
  displayName: "cf-user@example.invalid",
  mode: "server_held",
  status: "ready",
  grantedScopes: scopes,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  workspaceIds: [],
};
let accounts: (typeof account)[] = scenario === "ready" ? [account] : [];
let bindings: object[] = [];
let approved = false;
let calls = 0;
let verifies = 0;
let saves = 0;
let attempts = 0;
let reads = 0;
const operations = new Map<string, string>();
let operation = "";
Object.assign(window, {
  approveCloudflareFixture: () => {
    approved = true;
  },
  cloudflareFixtureStats: () => ({
    grants: operations.size,
    calls,
    saves,
    reads,
    operation,
    bindings,
    accounts: accounts.length,
  }),
});
const view = () => ({ workspaceId: "ws_cf_fixture", accounts, bindings });
window.fetch = async (input, init = {}) => {
  const u = new URL(String(input), location.origin);
  const path = u.pathname;
  const body = init.body ? JSON.parse(String(init.body)) : {};
  let answer: unknown = {};
  let status = 200;
  if (path === "/api/workspaces")
    answer = [
      {
        id: "ws_cf_fixture",
        name: "Fixture project",
        accessRole: "owner",
        deviceId: "fixture-device",
        localPath: "/fixture/project",
      },
    ];
  else if (path === "/api/devices")
    answer = [
      { id: "fixture-device", label: "Fixture device", status: "connected" },
    ];
  else if (path === "/api/external-accounts")
    answer = {
      accounts,
      apps: [],
      providers: [
        {
          kind: "cloudflare",
          label: "Cloudflare",
          credentialMode: "server_held",
          authMethods: ["oauth_authorization_code"],
          tools: ["cf"],
        },
      ],
      secretsConfigured: true,
    };
  else if (path.endsWith("/external-accounts")) {
    if (init.method === "PUT") {
      saves++;
      if (scenario === "binding_failure" && saves === 1) {
        status = 503;
        answer = {
          error: "Fixture save failed; authorization remains connected",
        };
      } else {
        bindings = body.accountIds.map((id: string) => ({
          workspaceId: "ws_cf_fixture",
          accountId: id,
          grantedBy: "fixture-owner",
          createdAt: new Date().toISOString(),
          resourceIds: body.resources?.[id] ?? [],
        }));
        answer = view();
      }
    } else answer = view();
  } else if (path.endsWith("/device-connectors"))
    answer = {
      workspaceId: "ws_cf_fixture",
      connectors: [],
      bindings: [],
      devices: [],
      executionDevices: [],
    };
  else if (path === "/api/connectors/cloudflare/sign-in") {
    calls++;
    if (!operations.has(body.requestId)) {
      operations.set(
        body.requestId,
        `fixture-operation-${operations.size + 1}`,
      );
      approved = false;
      verifies = 0;
    }
    operation = operations.get(body.requestId)!;
    if (scenario === "lost_receipt" && calls <= 2) {
      status = 503;
      answer = {
        error: "Fixture connection interrupted after receipt creation",
      };
    } else
      answer = {
        id: operation,
        provider: "cloudflare",
        appId: "fixture-public",
        status: "pending",
        phase: "register",
        intervalSeconds: 2,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
  } else if (path.startsWith("/api/external-accounts/logins/")) {
    attempts++;
    if (scenario === "restart_unknown") {
      accounts = [account];
      status = 404;
      answer = { error: "Authorization is no longer known" };
    } else if (approved && ++verifies > 1) {
      accounts = [account];
      answer = {
        id: operation,
        provider: "cloudflare",
        appId: "fixture-public",
        status: "complete",
        account,
      };
    } else
      answer = {
        id: operation,
        provider: "cloudflare",
        appId: "fixture-public",
        status: "pending",
        phase: approved ? "verifying" : "authorize",
        requestedScopes: scopes,
        verificationUri: approved
          ? undefined
          : `https://mcp.cloudflare.com/authorize?client_id=fixture-only&state=${operation}&code_challenge=synthetic-fixture`,
        intervalSeconds: 2,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
  } else if (path.startsWith("/api/connectors/cloudflare/logins/")) answer = {};
  else if (path.endsWith("/zones")) {
    reads++;
    answer = {
      success: true,
      result: [zone, other],
      result_info: { total_pages: 1 },
    };
  } else if (path.endsWith("/revoke")) {
    accounts = [{ ...account, status: "revoked" }];
    answer = accounts[0];
  } else {
    status = 404;
    answer = { error: `Unconfigured fixture endpoint: ${path}` };
  }
  return new Response(JSON.stringify(answer), {
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
      <h1>Cloudflare Connector · synthetic fixture</h1>
      {mode === "global" ? (
        <ConnectorsFeature
          tab="cloudflare"
          onTabChange={() => {}}
          currentUserId="fixture-owner"
          isAdmin={false}
          onNotice={setNotice}
        />
      ) : (
        <WorkspaceConnectorsFeature
          workspaceId="ws_cf_fixture"
          currentUserId="fixture-owner"
          onNotice={setNotice}
        />
      )}
      <p role="status">{notice}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
