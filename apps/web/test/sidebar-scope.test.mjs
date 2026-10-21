import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
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

const { AppSidebar } = await import("../src/app/app-sidebar.tsx");
const { AccountsGate } = await import("../src/app/accounts-gate.tsx");
const { withAccountNav } = await import("../src/app/account-views.tsx");
const { navSections, workspaceScopedViews } =
  await import("../src/app/navigation.ts");
const { CompactLocationSwitcher } =
  await import("../src/features/workspaces/compact-location-switcher.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
window.HTMLElement.prototype.scrollIntoView = () => {};
const preferences = {
  sidebarCollapsed: false,
  themeMode: "light",
  toggleThemeMode() {},
  toggleSidebarCollapsed() {},
};
async function mounted(props = {}, role = "member") {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        user: { id: "synthetic", username: "synthetic", role, locale: "en" },
      }),
      { headers: { "content-type": "application/json" } },
    );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const selected = [];
  await act(async () =>
    root.render(
      createElement(
        AccountsGate,
        null,
        createElement(AppSidebar, {
          activeView: "assistant",
          interfaceMode: "full",
          counts: { review: 2, running: 3, activeSkills: 5 },
          onNavSelect: (id) => selected.push(id),
          onNotice() {},
          preferences,
          workspaceName: "Alpha",
          workspaceSelector: createElement(
            "button",
            { "data-test-selector": true },
            "Alpha",
          ),
          ...props,
        }),
      ),
    ),
  );
  return {
    container,
    selected,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
test("selector belongs only to Workspace; global navigation works without a workspace", async () => {
  const v = await mounted({ workspaceName: "" });
  assert.deepEqual(
    [...v.container.querySelectorAll("[data-section-id]")].map(
      (e) => e.dataset.sectionId,
    ),
    ["workspace", "assistant", "manage"],
  );
  const divider = v.container.querySelector(".fdy-sidebar-scope-divider");
  assert.equal(divider.previousElementSibling.dataset.sectionId, "workspace");
  assert.equal(divider.nextElementSibling.dataset.sectionId, "assistant");
  assert.equal(
    v.container.querySelectorAll(".fdy-sidebar-scope-divider").length,
    1,
  );
  assert.equal(
    v.container
      .querySelector("[data-test-selector]")
      .closest("[data-section-id]").dataset.sectionId,
    "workspace",
  );
  assert.equal(
    v.container
      .querySelector(".fdy-sidebar-brand")
      .textContent.includes("Alpha"),
    false,
  );
  for (const b of v.container.querySelectorAll(
    '[data-section-id="manage"] [data-nav-id], [data-section-id="assistant"] [data-nav-id]',
  )) {
    assert.equal(b.disabled, false);
    assert.equal(workspaceScopedViews.has(b.dataset.navId), false);
    await act(async () => b.click());
    assert.equal(v.selected.at(-1), b.dataset.navId);
  }
  assert.equal(v.container.querySelector('[data-nav-id="members"]'), null);
  await v.close();
});
test("simple interface omits workspace controls and preserves account roles", async () => {
  const v = await mounted({ interfaceMode: "simple" }, "admin");
  for (const selector of [
    '[data-section-id="workspace"]',
    "[data-test-selector]",
    '[data-nav-id="devices"]',
    ".fdy-sidebar-scope-divider",
  ])
    assert.equal(v.container.querySelector(selector), null);
  for (const id of ["members", "account"])
    assert.ok(v.container.querySelector(`[data-nav-id="${id}"]`));
  await v.close();
});
test("localized groups retain identity, selected state and live counts", async () => {
  const v = await mounted({ activeView: "issue" });
  const workspace = v.container.querySelector('[data-section-id="workspace"]');
  const issues = v.container.querySelector('[data-nav-id="issues"]');
  assert.equal(issues.getAttribute("aria-current"), "page");
  assert.equal(issues.querySelector("b").textContent, "2");
  assert.equal(issues.querySelector("i").textContent, "3");
  await act(async () => i18n.changeLanguage("zh-CN"));
  assert.equal(
    v.container.querySelector('[data-section-id="workspace"]').dataset
      .sectionId,
    workspace.dataset.sectionId,
  );
  assert.match(v.container.textContent, /助理设置/);
  assert.match(v.container.textContent, /全局管理/);
  assert.match(issues.title, /Alpha/);
  await v.close();
  await i18n.changeLanguage("en");
  const localized = navSections.map((s) => ({ ...s, label: "translated" }));
  assert.ok(
    withAccountNav(localized, "admin")
      .find((s) => s.id === "manage")
      .items.some((i) => i.id === "members"),
  );
});
test("location entry describes actual context, offline and removed history without invented device", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  for (const status of ["connected", "disconnected", "removed"]) {
    await act(async () =>
      root.render(
        createElement(CompactLocationSwitcher, {
          collapsed: true,
          workspace: { name: "Long workspace name" },
          device: { label: "Actual device", status },
          onBrowse() {},
        }),
      ),
    );
    const b = container.querySelector("button");
    assert.match(
      b.getAttribute("aria-label"),
      /Long workspace name.*Actual device/,
    );
    assert.equal(
      container.querySelector(".fdy-location-entry-rows").firstElementChild
        .textContent,
      "Long workspace name",
    );
    if (status !== "connected")
      assert.match(
        b.title,
        new RegExp(status === "disconnected" ? "offline" : status, "i"),
      );
  }
  await act(async () =>
    root.render(createElement(CompactLocationSwitcher, { onBrowse() {} })),
  );
  assert.equal(container.querySelector(".fdy-location-entry-device"), null);
  await act(async () => root.unmount());
  container.remove();
});

test("arrow navigation includes the section selector and all global entries", async () => {
  const v = await mounted();
  const buttons = [...v.container.querySelectorAll(".fdy-sidebar-nav button")];
  await act(async () => buttons[0].focus());
  const browserShortcut = new KeyboardEvent("keydown", {
    key: "ArrowLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => buttons[0].dispatchEvent(browserShortcut));
  assert.equal(browserShortcut.defaultPrevented, false);
  assert.equal(document.activeElement === buttons[0], true);
  for (let n = 1; n < buttons.length; n++) {
    await act(async () =>
      document.activeElement.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement === buttons[n], true);
  }
  await act(async () =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  assert.equal(document.activeElement === buttons[0], true);
  await v.close();
});

test("height-only viewport changes do not pull focus or scrolling back to navigation", async () => {
  let reveals = 0;
  const original = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = () => reveals++;
  try {
    const v = await mounted();
    const before = reveals;
    assert.ok(before > 0);
    await act(async () => window.dispatchEvent(new Event("resize")));
    assert.equal(reveals, before);
    await v.close();
  } finally {
    window.HTMLElement.prototype.scrollIntoView = original;
  }
});

test("brand controls form an accessible function group outside navigation", async () => {
  const v = await mounted({
    preferences: { ...preferences, sidebarCollapsed: true },
  });
  const group = v.container.querySelector(".fdy-sidebar-brand-actions");
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(group.getAttribute("aria-label"), "Interface controls");
  assert.equal(group.closest("nav"), null);
  const buttons = [...group.querySelectorAll("button")];
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((b) => b.getAttribute("aria-label") && b.title));
  await v.close();
});
