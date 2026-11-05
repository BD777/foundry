// The shared permission-set choice (DEV-136): recommended, all, custom,
// what is asked for and how it changes the current grant.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const {
  initialSelection,
  normalizeSelection,
  parseScopeList,
  permissionPlan,
  selectionFor,
  filterScopes,
  groupByArea,
  catalogScopes,
} = await import("../src/features/external-accounts/permission-selection.ts");

// GitHub-shaped: a minimum, a family with children, extras.
const scopes = [
  { id: "repo", required: true, recommended: true },
  { id: "repo:status", impliedBy: ["repo"] },
  {
    id: "read:org",
    required: true,
    recommended: true,
    impliedBy: ["admin:org"],
  },
  { id: "admin:org" },
  { id: "workflow", recommended: true },
  { id: "delete_repo" },
  { id: "spark:app:write", unavailable: true },
];

test("recommended and all; all leaves out what the app cannot grant", () => {
  assert.deepEqual(selectionFor("recommended", scopes), [
    "repo",
    "read:org",
    "workflow",
  ]);
  assert.deepEqual(selectionFor("all", scopes), [
    "repo",
    "admin:org",
    "workflow",
    "delete_repo",
  ]);
});

test("a selection keeps required scopes and drops what a broader one includes", () => {
  assert.deepEqual(
    normalizeSelection(["repo:status", "admin:org", "nope"], scopes),
    ["repo", "admin:org"],
  );
});

test("an update starts from what is granted; a first authorization from recommended", () => {
  assert.deepEqual(
    initialSelection(scopes, ["repo", "read:org", "delete_repo"]),
    {
      mode: "custom",
      selected: ["repo", "read:org", "delete_repo"],
    },
  );
  assert.equal(initialSelection(scopes).mode, "recommended");
});

test("the plan asks for always-scopes first and names adds and removes", () => {
  const granted = ["repo", "repo:status", "read:org", "delete_repo"];
  assert.deepEqual(
    permissionPlan(["repo", "read:org", "workflow"], scopes, {
      granted,
      always: ["offline_access"],
      removes: true,
    }),
    {
      request: ["offline_access", "repo", "read:org", "workflow"],
      add: ["workflow"],
      remove: ["delete_repo"],
    },
  );
  // An authorization that only adds never says it removes.
  assert.deepEqual(
    permissionPlan(["repo"], scopes, { granted, removes: false }).remove,
    [],
  );
  // A child of a granted broad scope is not "added".
  assert.deepEqual(
    permissionPlan(["read:org"], scopes, {
      granted: ["admin:org"],
      removes: true,
    }).add,
    ["repo"],
  );
});

test("a pasted list keeps listed scopes and reports the rest", () => {
  assert.deepEqual(parseScopeList("repo, workflow\nsite_admin  repo", scopes), {
    known: ["repo", "workflow"],
    unknown: ["site_admin"],
  });
});

test("filter and headings", () => {
  const listed = catalogScopes(
    { scopes: [{ id: "zone.read", recommended: true }, { id: "dns.write" }] },
    (id) => id.split(".")[0],
  );
  assert.deepEqual(
    filterScopes(listed, "DNS").map((s) => s.id),
    ["dns.write"],
  );
  assert.deepEqual(
    groupByArea(listed).map((g) => g.area),
    ["zone", "dns"],
  );
});
