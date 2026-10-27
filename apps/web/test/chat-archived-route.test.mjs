import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
// The location hook initializes workspace data. Supply Vite's empty env for
// that .ts module, just as the common resolver does for .tsx modules.
register(
  `data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    const loaded = await nextLoad(url, context);
    if (!url.endsWith("/src/app/use-workspace-data.ts")) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    return { ...loaded, source: source.replaceAll("import.meta.env", "({})") };
  }
`)}`,
  import.meta.url,
);

test("a hard Archived route survives initial workspace selection and subsequent data reconciliation, while explicit chat navigation opens the transcript", async () => {
  const window = new Window({
    url: "https://foundry.test/chats/archived?workspace=archive-workspace",
  });
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { useAppLocation } = await import("../src/app/use-app-location.ts");
  const { useAppRouteSync } = await import("../src/app/use-app-route-sync.ts");
  const { parseAppRoute } = await import("../src/app/navigation.ts");
  const { chatSelectionAfterRead } =
    await import("../src/app/loaded-foundry-data.ts");
  const { emptyFoundryData } = await import("../src/app/initial-data.ts");
  let location;
  function Harness() {
    location = useAppLocation();
    useAppRouteSync({
      activeView: location.activeView,
      activeWorkspaceId: "archive-workspace",
      chatView: location.chatView,
      selectedChatId: location.selectedChatId,
      selectedIssueId: location.selectedIssueId,
      onPopState: (route) => location.showRoute(route),
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const assertArchived = () => {
    assert.equal(location.chatView, "archived");
    assert.equal(window.location.pathname, "/chats/archived");
    assert.equal(window.location.search, "?workspace=archive-workspace");
  };
  try {
    await act(() => root.render(createElement(Harness)));
    assertArchived();
    // loadWorkspace resolves a preferred chat after its request completes.
    await act(() => location.setSelectedChatId("first-active-chat"));
    assertArchived();
    // refreshData reconciles the selected id against the freshly read list.
    const loaded = {
      ...emptyFoundryData,
      chats: [{ id: "first-active-chat" }],
    };
    for (let read = 0; read < 3; read++) {
      await act(() =>
        location.setSelectedChatId((current) =>
          chatSelectionAfterRead(loaded, current),
        ),
      );
      assertArchived();
    }
    await act(() => location.selectChat("first-active-chat"));
    assert.equal(location.chatView, "active");
    assert.equal(window.location.pathname, "/chats/first-active-chat");
    assert.equal(window.location.search, "?workspace=archive-workspace");
    await act(() => location.showRoute(parseAppRoute("/chats/archived")));
    await act(() => location.setSelectedChatId((current) => current));
    assertArchived();
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
