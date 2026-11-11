import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/connectors/edge-access",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { EdgeAccessListView } =
  await import("../src/features/external-accounts/edge-access.tsx");
const { EdgeAccessRequiredNotice, edgeAccessRequiredOf } =
  await import("../src/features/external-accounts/edge-access-required.tsx");
const { parseAppRoute, pathForAppRoute } = await import("../src/lib/routes.ts");
const { ApiError } = await import("../src/api/http.ts");

const mounted = new Set();
test.afterEach(async () => {
  for (const root of mounted) await act(async () => root.unmount());
  mounted.clear();
  window.document.body.innerHTML = "";
  window.history.replaceState(null, "", "/connectors/edge-access");
});

async function render(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  mounted.add(root);
  await act(async () => root.render(createElement(component, props)));
  return {
    container,
    unmount: async () => {
      mounted.delete(root);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("edge access credentials show their provider, match and recent use", async () => {
  const page = await render(EdgeAccessListView, {
    credentials: [
      {
        id: "edge_1",
        label: "OpenLark production",
        provider: "cloudflare_access",
        match: { host: "openlark.example.com", pathPrefix: "/api" },
        team: "windeng",
        createdAt: "2026-11-12T00:00:00Z",
        updatedAt: "2026-11-12T00:00:00Z",
        lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      },
    ],
    onAdd: () => {},
    onDelete: () => {},
    onReplace: () => {},
  });
  const text = page.container.textContent;
  assert.match(text, /OpenLark production/);
  assert.match(text, /Cloudflare Access/);
  assert.match(text, /openlark\.example\.com\/api/);
  assert.match(text, /Last used/);
  assert.match(text, /3 hours ago/);
  assert.deepEqual(
    [...page.container.querySelectorAll("button")].map((button) =>
      button.textContent.trim(),
    ),
    ["Add credential", "Replace", "Delete"],
  );
  await page.unmount();
});

test("edge_access_required names the team and offers the pre-scoped add action", async () => {
  const required = {
    provider: "cloudflare_access",
    team: "windeng",
    host: "openlark.example.com",
    path: "/v1/messages",
    message: "Cloudflare Access requires a service token.",
  };
  assert.deepEqual(
    edgeAccessRequiredOf(
      new ApiError(
        "Cloudflare Access requires a service token.",
        400,
        "edge_access_required",
        {
          edgeAccess: required,
        },
      ),
    ),
    required,
  );
  const page = await render(EdgeAccessRequiredNotice, {
    required,
  });
  const alert = page.container.querySelector("[data-edge-access-required]");
  assert.ok(alert);
  assert.match(
    alert.textContent,
    /behind Cloudflare Access \(team windeng\).*edge access credential/,
  );
  assert.match(
    alert.textContent,
    /when the Cloudflare connector has Zero Trust authorization/,
  );
  const buttons = [...alert.querySelectorAll("button")];
  assert.deepEqual(
    buttons.map((button) => button.textContent.trim()),
    ["Add credential", "Provision automatically"],
  );
  assert.equal(buttons[1].disabled, false);
  await act(async () => buttons[0].click());
  assert.equal(window.location.pathname, "/connectors/edge-access");
  const params = new URLSearchParams(window.location.search);
  assert.equal(params.get("edgeHost"), "openlark.example.com");
  assert.equal(params.get("edgePath"), "/v1/messages");
  assert.deepEqual(parseAppRoute(window.location.pathname), {
    view: "connectors",
    connectorTab: "edge-access",
  });
  assert.equal(
    pathForAppRoute({ view: "connectors", connectorTab: "edge-access" }),
    "/connectors/edge-access",
  );
  await page.unmount();
});

test("automatic provisioning reports the credential and missing Tunnel ingress", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      path: new URL(String(input), window.location.href).pathname,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({
        edgeAccess: {
          id: "edge_2",
          label: "OpenLark",
          provider: "cloudflare_access",
          match: { host: "openlark.example.com", pathPrefix: "/v1" },
          team: "windeng",
          createdAt: "2026-11-12T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
        },
        accountId: "cf_account",
        serviceTokenName: "Foundry OpenLark",
        serviceTokenId: "token_1",
        applicationId: "app_1",
        policyId: "policy_1",
        needsIngress: true,
        suggestedIngress: {
          hostname: "openlark.example.com",
          path: "/v1",
          service: "http://<origin>",
          note: "Add this rule before the tunnel's catch-all rule.",
        },
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  try {
    let refreshed = 0;
    const page = await render(EdgeAccessRequiredNotice, {
      onProvisioned: () => {
        refreshed += 1;
      },
      required: {
        provider: "cloudflare_access",
        team: "windeng",
        host: "openlark.example.com",
        path: "/v1",
        message: "Cloudflare Access requires a service token.",
      },
    });
    const provision = [...page.container.querySelectorAll("button")].find(
      (button) => button.textContent.includes("Provision automatically"),
    );
    assert.ok(provision);
    await act(async () => {
      provision.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(requests, [
      {
        path: "/api/edge-access/provision",
        body: {
          provider: "cloudflare_access",
          team: "windeng",
          host: "openlark.example.com",
          path: "/v1",
        },
      },
    ]);
    const success = page.container.querySelector(
      "[data-edge-access-provisioned]",
    );
    assert.ok(success);
    assert.match(success.textContent, /Edge access is ready/);
    assert.match(success.textContent, /Tunnel is still missing this route/);
    assert.match(success.textContent, /openlark\.example\.com/);
    assert.match(success.textContent, /http:\/\/<origin>/);
    assert.equal(refreshed, 1);
    await page.unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("automatic provisioning links to Cloudflare when Zero Trust is not authorized", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "cloudflare_zero_trust_required",
        error: "Cloudflare connector requires Zero Trust authorization.",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  try {
    const page = await render(EdgeAccessRequiredNotice, {
      required: {
        provider: "cloudflare_access",
        host: "openlark.example.com",
        path: "/v1",
        message: "Cloudflare Access requires a service token.",
      },
    });
    const provision = [...page.container.querySelectorAll("button")].find(
      (button) => button.textContent.includes("Provision automatically"),
    );
    assert.ok(provision);
    await act(async () => {
      provision.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      page.container.textContent,
      /Authorize Zero Trust first in Connectors › Cloudflare/,
    );
    assert.equal(
      page.container.querySelector('a[href="/connectors/cloudflare"]')
        ?.textContent,
      "Open Cloudflare",
    );
    await page.unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
