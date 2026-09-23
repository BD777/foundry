import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const {
  buildPickerAgentOptions,
  canonicalPickerAgents,
  pickerAgentMeta,
  pickerAgentLabel,
  promotedLegacyAgentIds,
  shortUnavailableReason,
} = await import("../src/lib/agent-picker.ts");

const deviceId = "dev_1";
const serverProfileId = "prof_server";

const deviceProfile = (overrides = {}) => ({
  id: "claude_local",
  deviceId,
  origin: "device",
  runtime: "claude",
  promotedProfileId: serverProfileId,
  ...overrides,
});
const serverProfileRow = (id = serverProfileId, label = "team-relay") => ({
  id,
  deviceId,
  origin: "server",
  runtime: "claude",
  label,
});
const deviceAgent = (overrides = {}) => ({
  id: "agent_device",
  deviceId,
  workspaceId: "ws",
  provider: "claude",
  profileId: "claude_local",
  profileLabel: "team-relay",
  connectionType: "env",
  status: "healthy",
  ...overrides,
});
const serverAgent = (overrides = {}) => ({
  id: "agent_server",
  deviceId,
  workspaceId: "ws",
  provider: "claude",
  profileId: serverProfileId,
  profileLabel: "team-relay",
  connectionType: "anthropic_compatible",
  status: "healthy",
  ...overrides,
});
const pair = () => [deviceAgent(), serverAgent()];
const pairProfiles = () => [deviceProfile(), serverProfileRow()];

test("a fresh picker shows a promoted pair once, represented by the server row", () => {
  const visible = canonicalPickerAgents(pair(), pairProfiles());
  assert.deepEqual(
    visible.map((agent) => agent.id),
    ["agent_server"],
  );
  assert.deepEqual(
    promotedLegacyAgentIds(pair(), pairProfiles()),
    new Set(["agent_device"]),
  );
});

test("an existing chat on the legacy config shows the pair once as that legacy row", () => {
  const visible = canonicalPickerAgents(pair(), pairProfiles(), "agent_device");
  assert.deepEqual(
    visible.map((agent) => agent.id),
    ["agent_device"],
  );
});

test("selecting another agent makes the group present its server representative again", () => {
  const agents = [
    deviceAgent(),
    serverAgent(),
    {
      id: "agent_official",
      deviceId,
      workspaceId: "ws",
      provider: "claude",
      profileId: "foundry_official_claude",
      connectionType: "local_login",
      status: "healthy",
    },
  ];
  // Official selected explicitly: legacy alias hidden, server row back.
  const visible = canonicalPickerAgents(
    agents,
    [
      ...pairProfiles(),
      { id: "foundry_official_claude", deviceId, origin: "device" },
    ],
    "agent_official",
  );
  assert.deepEqual(visible.map((agent) => agent.id).sort(), [
    "agent_official",
    "agent_server",
  ]);
});

test("the representative carries no local/server source subline in any state", () => {
  for (const selected of [undefined, "agent_device", "agent_server"]) {
    const options = buildPickerAgentOptions(pair(), pairProfiles(), selected);
    assert.equal(options.length, 1);
    assert.equal(options[0].meta, undefined);
  }
  assert.deepEqual(pickerAgentMeta(serverAgent()), {});
  assert.deepEqual(pickerAgentMeta(deviceAgent()), {});
});

test("the legacy representative keeps the legacy value while it is checked", () => {
  const options = buildPickerAgentOptions(
    pair(),
    pairProfiles(),
    "agent_device",
  );
  assert.equal(options[0].value, "agent_device");
  const serverOptions = buildPickerAgentOptions(pair(), pairProfiles());
  assert.equal(serverOptions[0].value, "agent_server");
});

test("no collapse when the server representative is missing or unhealthy", () => {
  const profiles = [deviceProfile()];
  // Missing server agent entirely.
  assert.deepEqual(
    canonicalPickerAgents([deviceAgent()], profiles).map((a) => a.id),
    ["agent_device"],
  );
  // A server profile/agent pair with no projection row at all: legacy stays.
  const noProjection = [deviceAgent()];
  assert.deepEqual(
    canonicalPickerAgents(noProjection, profiles).map((a) => a.id),
    ["agent_device"],
  );
});

test("an unhealthy linked server still collapses once, carrying the reason", () => {
  const agents = [deviceAgent(), serverAgent({ status: "missing_auth" })];
  // One row, and it is the server row (legacy alias hidden by default).
  const visible = canonicalPickerAgents(agents, pairProfiles());
  assert.deepEqual(
    visible.map((a) => a.id),
    ["agent_server"],
  );
  assert.equal(visible[0].status, "missing_auth");
  const options = buildPickerAgentOptions(agents, pairProfiles());
  assert.equal(options.length, 1);
  assert.match(options[0].detail ?? "", /sign-in|credential|unavailable/i);
  // A historical chat on legacy keeps one row too, represented by legacy.
  assert.deepEqual(
    canonicalPickerAgents(agents, pairProfiles(), "agent_device").map(
      (a) => a.id,
    ),
    ["agent_device"],
  );
});

test("a link requires same workspace and provider plus a server-origin proof", () => {
  const crossWorkspace = serverAgent({ workspaceId: "ws_other" });
  assert.deepEqual(
    promotedLegacyAgentIds([deviceAgent(), crossWorkspace], pairProfiles()),
    new Set(),
  );
  const crossProvider = serverAgent({ provider: "codex" });
  assert.deepEqual(
    promotedLegacyAgentIds([deviceAgent(), crossProvider], pairProfiles()),
    new Set(),
  );
  // Pointer present, but no server-origin projection row proving the profile.
  assert.deepEqual(
    promotedLegacyAgentIds(pair(), [deviceProfile()]),
    new Set(),
  );
});

test("several legacy aliases for one server collapse from the selected alias only", () => {
  const agents = [
    deviceAgent({ id: "legacy_one", profileId: "local_one" }),
    deviceAgent({ id: "legacy_two", profileId: "local_two" }),
    serverAgent(),
  ];
  const profiles = [
    deviceProfile({ id: "local_one", promotedProfileId: serverProfileId }),
    deviceProfile({ id: "local_two", promotedProfileId: serverProfileId }),
    serverProfileRow(),
  ];
  // No selection: both aliases hidden, one server row.
  assert.deepEqual(
    canonicalPickerAgents(agents, profiles).map((a) => a.id),
    ["agent_server"],
  );
  // First alias selected: it survives, server hidden, second alias hidden.
  assert.deepEqual(
    canonicalPickerAgents(agents, profiles, "legacy_one").map((a) => a.id),
    ["legacy_one"],
  );
  // Second alias selected: same rule, independent of ordering.
  assert.deepEqual(
    canonicalPickerAgents(agents, profiles, "legacy_two").map((a) => a.id),
    ["legacy_two"],
  );
});

test("same-named connections without a promoted pointer are never collapsed", () => {
  const first = serverAgent({
    id: "agent_server_a",
    profileId: "prof_a",
    profileLabel: "shared-name",
  });
  const second = serverAgent({
    id: "agent_server_b",
    profileId: "prof_b",
    profileLabel: "shared-name",
  });
  const profiles = [
    serverProfileRow("prof_a", "shared-name"),
    serverProfileRow("prof_b", "shared-name"),
  ];
  assert.deepEqual(
    canonicalPickerAgents([first, second], profiles)
      .map((a) => a.id)
      .sort(),
    ["agent_server_a", "agent_server_b"],
  );
  // And a device row without the pointer stays even with a same-name server.
  const plain = deviceAgent({
    id: "agent_plain",
    profileId: "plain_local",
  });
  const withPlain = [plain, serverAgent({ profileLabel: "team-relay" })];
  const plainProfiles = [
    { id: "plain_local", deviceId, origin: "device" },
    serverProfileRow(),
  ];
  assert.deepEqual(
    canonicalPickerAgents(withPlain, plainProfiles)
      .map((a) => a.id)
      .sort(),
    ["agent_plain", "agent_server"],
  );
});

test("unavailable rows keep a short reason; healthy official accounts have none", () => {
  const codex = {
    ...deviceAgent(),
    id: "agent_codex",
    provider: "codex",
    profileId: "codex_local",
    connectionType: "local_login",
    status: "missing_auth",
    statusDetail:
      "No official login in the worker's ~/.codex configuration. Other apps may use a different configuration.",
  };
  const meta = pickerAgentMeta(codex);
  assert.equal(meta.detail, "Worker configuration is not signed in.");
  assert.match(meta.title ?? "", /\.codex/);
  assert.equal(
    pickerAgentLabel({ ...codex, status: "healthy" }),
    "Codex · Device account",
  );
  assert.equal(
    shortUnavailableReason("missing_auth", undefined),
    "No sign-in or credential on this device.",
  );
  assert.equal(
    shortUnavailableReason("unavailable", "Device is offline."),
    "Device is offline.",
  );
});
