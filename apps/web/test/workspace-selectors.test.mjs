import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Registered before the dynamic import so the resolver covers the whole graph.
register("./bundler-resolve.mjs", import.meta.url);
const {
  agentsForDevice,
  currentDevice,
  currentProviderHealth,
  currentWorkspaceAgents,
  currentWorkspaceAssets,
  currentWorkspaceItems,
  currentWorkspaceSkills,
  profilesForDevice,
  uniqueSkills,
} = await import("../src/app/workspace-selectors.ts");

function agent(id, overrides = {}) {
  return {
    authMode: "subscription",
    deviceId: "dev_1",
    id,
    provider: "claude",
    secretStored: "local",
    status: "healthy",
    workspaceId: "ws_1",
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return { deviceId: "dev_1", id: "ws_1", name: "Foundry", ...overrides };
}

function issue(id, skills) {
  return { id, skills };
}

test("workspace agents exclude other workspaces", () => {
  const agents = currentWorkspaceAgents(
    [agent("a"), agent("b", { workspaceId: "ws_2" })],
    workspace(),
  );

  assert.deepEqual(
    agents.map((entry) => entry.id),
    ["a"],
  );
});

test("an empty workspace id isolates every agent", () => {
  assert.deepEqual(
    currentWorkspaceAgents(
      [agent("a", { workspaceId: "" })],
      workspace({ id: "" }),
    ),
    [],
  );
});

test("workspace agents never fall back to another device", () => {
  const onDevice = currentWorkspaceAgents(
    [agent("other", { deviceId: "dev_2" }), agent("mine")],
    workspace(),
  );
  assert.deepEqual(
    onDevice.map((entry) => entry.id),
    ["mine"],
  );

  const noneOnDevice = currentWorkspaceAgents(
    [agent("other", { deviceId: "dev_2" })],
    workspace({ deviceId: "dev_9" }),
  );
  assert.deepEqual(
    noneOnDevice.map((entry) => entry.id),
    [],
  );
});

test("workspace agents sort healthy first, then provider, then label", () => {
  const agents = currentWorkspaceAgents(
    [
      agent("codex-sick", { provider: "codex", status: "unavailable" }),
      agent("claude-b", { profileLabel: "B" }),
      agent("codex-ok", { provider: "codex" }),
      agent("claude-a", { profileLabel: "A" }),
    ],
    workspace(),
  );

  assert.deepEqual(
    agents.map((entry) => entry.id),
    ["claude-a", "claude-b", "codex-ok", "codex-sick"],
  );
});

test("provider health prefers a healthy agent over an unhealthy one", () => {
  const health = currentProviderHealth(
    [],
    [
      agent("sick", { authMode: "missing", status: "unavailable" }),
      agent("ok", { authMode: "subscription", status: "healthy" }),
    ],
  );

  assert.deepEqual(health[0], {
    authMode: "subscription",
    provider: "claude",
    secretStored: "local",
    status: "healthy",
  });
});

test("provider health falls back to the server row, then to unavailable", () => {
  const health = currentProviderHealth(
    [
      {
        authMode: "api-key",
        provider: "codex",
        secretStored: "keychain",
        status: "healthy",
      },
    ],
    [],
  );

  assert.deepEqual(
    health.map((entry) => entry.provider),
    ["claude", "codex"],
  );
  assert.deepEqual(health[0], {
    authMode: "missing",
    provider: "claude",
    secretStored: "local",
    status: "unavailable",
  });
  assert.equal(health[1].secretStored, "keychain");
});

test("agent health always wins over the server row for the same provider", () => {
  const health = currentProviderHealth(
    [
      {
        authMode: "api-key",
        provider: "claude",
        secretStored: "keychain",
        status: "healthy",
      },
    ],
    [agent("sick", { authMode: "missing", status: "unavailable" })],
  );

  assert.equal(health[0].status, "unavailable");
  assert.equal(health[0].secretStored, "local");
});

test("workspace items keep only the active workspace", () => {
  assert.deepEqual(
    currentWorkspaceItems(
      [
        { id: "a", workspaceId: "ws_1" },
        { id: "b", workspaceId: "ws_2" },
      ],
      "ws_1",
    ),
    [{ id: "a", workspaceId: "ws_1" }],
  );
  assert.deepEqual(
    currentWorkspaceItems([{ id: "a", workspaceId: "ws_1" }], ""),
    [],
  );
});

test("assets and skills without a workspace stay globally visible", () => {
  const assets = [
    { id: "global" },
    { id: "mine", workspaceId: "ws_1" },
    { id: "theirs", workspaceId: "ws_2" },
  ];
  assert.deepEqual(
    currentWorkspaceAssets(assets, "ws_1").map((entry) => entry.id),
    ["global", "mine"],
  );

  const skills = [
    { id: "global", name: "global", version: "1.0.0" },
    { id: "mine", name: "mine", version: "1.0.0", workspaceId: "ws_1" },
    { id: "theirs", name: "theirs", version: "1.0.0", workspaceId: "ws_2" },
  ];
  assert.deepEqual(
    currentWorkspaceSkills(skills, "ws_1").map((entry) => entry.id),
    ["global", "mine"],
  );
});

test("a missing workspace device never silently switches to another device", () => {
  const devices = [{ id: "dev_1" }, { id: "dev_2" }];

  assert.equal(
    currentDevice(devices, workspace({ deviceId: "dev_2" })).id,
    "dev_2",
  );
  assert.equal(
    currentDevice(devices, workspace({ deviceId: "gone" })),
    undefined,
  );
  assert.equal(
    currentDevice(devices, workspace({ deviceId: undefined })).id,
    "dev_1",
  );
  assert.equal(currentDevice([], workspace()), undefined);
});

test("device scoping keeps every record until a device resolves", () => {
  const agents = [agent("a"), agent("b", { deviceId: "dev_2" })];
  assert.deepEqual(
    agentsForDevice(agents, "dev_1").map((entry) => entry.id),
    ["a"],
  );
  assert.deepEqual(
    agentsForDevice(agents, undefined).map((entry) => entry.id),
    ["a", "b"],
  );

  const profiles = [
    { deviceId: "dev_1", id: "p1" },
    { deviceId: "dev_2", id: "p2" },
  ];
  assert.deepEqual(
    profilesForDevice(profiles, "dev_2").map((entry) => entry.id),
    ["p2"],
  );
  assert.deepEqual(
    profilesForDevice(profiles, undefined).map((entry) => entry.id),
    ["p1", "p2"],
  );
});

test("issue skills dedupe by id and keep the curated design order", () => {
  const skills = uniqueSkills([
    issue("i1", [
      { id: "visual-qa", name: "Visual QA", version: "0.2.0" },
      { id: "shadcn-ui-cleanup", name: "Cleanup", version: "0.1.0" },
    ]),
    issue("i2", [{ id: "visual-qa", name: "Visual QA", version: "0.3.0" }]),
  ]);

  assert.deepEqual(
    skills.map((skill) => skill.id),
    [
      "baseline-comparison",
      "web-preview-acceptance",
      "visual-qa",
      "issue-splitting",
      "shadcn-ui-cleanup",
    ],
  );
  // The last issue reference wins for a duplicated id.
  assert.equal(
    skills.find((skill) => skill.id === "visual-qa").version,
    "0.3.0",
  );
});

test("issue skills advertise capability skills even without issues", () => {
  assert.deepEqual(
    uniqueSkills([]).map((skill) => skill.id),
    [
      "baseline-comparison",
      "web-preview-acceptance",
      "visual-qa",
      "issue-splitting",
    ],
  );
});

test("unlisted skills sort behind the curated ones in discovery order", () => {
  const skills = uniqueSkills([
    issue("i1", [
      { id: "zeta", name: "Zeta", version: "1.0.0" },
      { id: "alpha", name: "Alpha", version: "1.0.0" },
    ]),
  ]);

  assert.deepEqual(
    skills.slice(-2).map((skill) => skill.id),
    ["zeta", "alpha"],
  );
});
