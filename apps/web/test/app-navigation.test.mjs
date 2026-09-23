import assert from "node:assert/strict";
import test from "node:test";
import { parseAppRoute, pathForAppRoute } from "../src/app/navigation.ts";
import {
  viewErrorLabel,
  viewErrorResetKey,
} from "../src/app/view-error-policy.ts";
import {
  errorBoundaryMessage,
  requiresPageReload,
  shouldResetErrorBoundary,
} from "../src/lib/error-boundary-policy.ts";

test("module load failures require a page reload, ordinary render errors do not", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: http://127.0.0.1:31983/node_modules/.vite/deps/highlighted-body-old.js?v=old",
    "error loading dynamically imported module: https://example.test/chunk.js",
    "Importing a module script failed.",
    "Loading chunk 42 failed.",
  ]) {
    assert.equal(requiresPageReload(message), true);
  }
  for (const message of [
    "Failed to fetch",
    "Cannot read properties of undefined",
    "",
  ]) {
    assert.equal(requiresPageReload(message), false);
  }
});

const routes = [
  { view: "issues" },
  { view: "issue", selectedIssueId: "iss_42" },
  { view: "chats" },
  { view: "chats", selectedChatId: "chat_7" },
  { view: "assets" },
  { view: "skills" },
  { view: "settings" },
  { view: "feishu" },
  { view: "sharing" },
  { view: "workspace" },
  { view: "locations" },
  { view: "devices" },
  {
    view: "devices",
    selectedDeviceId: "dev/other machine",
    deviceSection: "agents",
  },
  { view: "devices", selectedDeviceId: "dev2", deviceSection: "workspaces" },
  { view: "profiles" },
];

test("workspace sections have canonical URLs while legacy links still resolve", () => {
  assert.deepEqual(parseAppRoute("/profiles"), { view: "profiles" });
  assert.equal(pathForAppRoute({ view: "profiles" }), "/connections");
  for (const section of ["settings", "assets", "skills", "feishu"]) {
    assert.deepEqual(parseAppRoute(`/${section}`), { view: section });
    assert.deepEqual(parseAppRoute(`/workspace/${section}`), { view: section });
    assert.equal(pathForAppRoute({ view: section }), `/workspace/${section}`);
  }
  assert.deepEqual(parseAppRoute("/workspace/sharing"), { view: "sharing" });
  assert.equal(pathForAppRoute({ view: "sharing" }), "/workspace/sharing");
});

test("global management routes and error boundaries do not inherit a workspace", () => {
  assert.deepEqual(parseAppRoute("/devices/dev2"), {
    view: "devices",
    selectedDeviceId: "dev2",
    deviceSection: "workspaces",
  });
  const route = {
    view: "devices",
    selectedDeviceId: "dev2",
    workspaceId: "ws1",
  };
  assert.equal(
    viewErrorResetKey(route),
    viewErrorResetKey({ ...route, workspaceId: "ws-other" }),
  );
  assert.notEqual(
    viewErrorResetKey(route),
    viewErrorResetKey({ ...route, selectedDeviceId: "dev3" }),
  );
});

// parseAppRoute may return an explicit `selectedChatId: undefined`, which is
// behaviourally the same route as omitting the key.
function normalizeRoute(route) {
  return Object.fromEntries(
    Object.entries(route).filter(([, value]) => value !== undefined),
  );
}

test("every route round trips through its path", () => {
  for (const route of routes) {
    assert.deepEqual(
      normalizeRoute(parseAppRoute(pathForAppRoute(route))),
      route,
      `round trip failed for ${JSON.stringify(route)}`,
    );
  }
});

test("round trips selection ids that need percent encoding", () => {
  const chatRoute = { view: "chats", selectedChatId: "chat/a b?c#d" };
  const chatPath = pathForAppRoute(chatRoute);

  assert.equal(chatPath, "/chats/chat%2Fa%20b%3Fc%23d");
  assert.deepEqual(normalizeRoute(parseAppRoute(chatPath)), chatRoute);

  const issueRoute = { view: "issue", selectedIssueId: "iss #9/ä" };
  assert.deepEqual(
    normalizeRoute(parseAppRoute(pathForAppRoute(issueRoute))),
    issueRoute,
  );
});

test("issue route without an id degrades to the issues list", () => {
  assert.equal(pathForAppRoute({ view: "issue" }), "/issues");
  assert.deepEqual(parseAppRoute("/issues"), { view: "issues" });
});

test("unknown and empty paths fall back to issues", () => {
  for (const path of ["", "/", "/nope", "/unknown/deep/path"]) {
    assert.deepEqual(parseAppRoute(path), { view: "issues" });
  }
});

test("tolerates trailing slashes and malformed percent escapes", () => {
  assert.deepEqual(parseAppRoute("/chats/"), {
    view: "chats",
    selectedChatId: undefined,
  });
  assert.deepEqual(parseAppRoute("/chats/chat%ZZ"), {
    view: "chats",
    selectedChatId: "chat%ZZ",
  });
});

test("extra path segments do not change the resolved view", () => {
  assert.deepEqual(normalizeRoute(parseAppRoute("/runs/extra")), {
    view: "issues",
  });
  assert.deepEqual(parseAppRoute("/issues/iss_1/timeline"), {
    view: "issue",
    selectedIssueId: "iss_1",
  });
});

test("view reset key tracks only the scope a view renders from", () => {
  const base = {
    selectedChatId: "chat_1",
    selectedIssueId: "iss_1",
    view: "chats",
    workspaceId: "ws_1",
  };

  assert.equal(
    viewErrorResetKey(base),
    viewErrorResetKey({ ...base, selectedIssueId: "iss_2" }),
    "chat view must ignore issue selection",
  );
  assert.notEqual(
    viewErrorResetKey(base),
    viewErrorResetKey({ ...base, selectedChatId: "chat_2" }),
  );
  assert.notEqual(
    viewErrorResetKey(base),
    viewErrorResetKey({ ...base, workspaceId: "ws_2" }),
  );

  const issueView = { ...base, view: "issue" };
  assert.notEqual(
    viewErrorResetKey(issueView),
    viewErrorResetKey({ ...issueView, selectedIssueId: "iss_2" }),
  );
  assert.equal(
    viewErrorResetKey(issueView),
    viewErrorResetKey({ ...issueView, selectedChatId: "chat_2" }),
  );

  const runsView = { ...base, view: "runs" };
  assert.equal(
    viewErrorResetKey(runsView),
    viewErrorResetKey({
      ...runsView,
      selectedChatId: "chat_9",
      selectedIssueId: "iss_9",
    }),
  );
});

test("every navigable view has boundary copy", () => {
  for (const route of routes) {
    assert.ok(viewErrorLabel(route.view), `missing label for ${route.view}`);
  }
});

test("boundary resets only for a failed scope that changed", () => {
  assert.equal(
    shouldResetErrorBoundary({
      failed: true,
      nextResetKey: "ws_1|runs|",
      previousResetKey: "ws_1|issues|",
    }),
    true,
  );
  assert.equal(
    shouldResetErrorBoundary({
      failed: true,
      nextResetKey: "ws_1|runs|",
      previousResetKey: "ws_1|runs|",
    }),
    false,
    "a stable scope must not clear the fallback on every re-render",
  );
  assert.equal(
    shouldResetErrorBoundary({
      failed: false,
      nextResetKey: "ws_1|runs|",
      previousResetKey: "ws_1|issues|",
    }),
    false,
  );
});

test("boundary message prefers the error text and never renders empty", () => {
  assert.equal(
    errorBoundaryMessage(new Error("cannot read runs")),
    "cannot read runs",
  );
  assert.equal(
    errorBoundaryMessage(new Error("   ")),
    "The view stopped responding.",
  );
  assert.equal(errorBoundaryMessage("boom"), "The view stopped responding.");
  assert.equal(errorBoundaryMessage(undefined), "The view stopped responding.");
});
