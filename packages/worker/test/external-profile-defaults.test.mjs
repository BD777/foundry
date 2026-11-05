// The person's defaults for a connector's model provider (DEV-135): set
// through the same upsert as a login's, kept apart from the connection the
// connector re-lists, and applied to the sessions it starts.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { saveConnectorModelProviders } from "../dist/harness/connector-model-providers.js";
import { externalProfileDefaultsPath } from "../dist/harness/external-profile-defaults.js";
import {
  agentProfilesForWorkspace,
  configuredAgentProfiles,
  profileConfigForSession,
  profileFingerprint,
  upsertAgentProfileConfig,
} from "../dist/harness/profiles.js";
import { listAgentModelsConfig } from "../dist/harness/models.js";
import { claudeEffort } from "../dist/session/runner/claude-options.js";

const provider = (patch = {}) => ({
  id: "gw_default",
  label: "Gateway · default",
  runtime: "claude",
  model: "claude-sonnet-4-5",
  models: ["claude-sonnet-4-5", "claude-opus-4-1"],
  externalConnection: {
    executable: "/bin/true",
    args: ["default"],
    identity: "person-a",
  },
  connector: { kind: "gw", label: "Gateway", extensionId: "gw" },
  ...patch,
});
const find = () =>
  configuredAgentProfiles("").find((row) => row.id === "gw_default");
const save = (patch = {}) =>
  upsertAgentProfileConfig(
    {
      id: "gw_default",
      label: "Gateway · default",
      runtime: "claude",
      connectionType: "external",
      configScope: "device",
      ...patch,
    },
    "",
  );

test.afterEach(() => {
  saveConnectorModelProviders([]);
  rmSync(externalProfileDefaultsPath(), { force: true });
});

test("a connector's provider takes the person's defaults and keeps them across re-listing", async () => {
  saveConnectorModelProviders([provider()]);
  const fingerprint = profileFingerprint(find());
  const saved = save({
    model: "claude-opus-4-1",
    claudeEffort: "high",
    claudePermissionMode: "acceptEdits",
  });
  assert.equal(saved.model, "claude-opus-4-1");
  assert.equal(saved.claudeEffort, "high");
  assert.equal(saved.claudePermissionMode, "acceptEdits");
  // The connection itself is untouched: same check fingerprint.
  assert.equal(profileFingerprint(find()), fingerprint);

  // Re-listed, unavailable for a while, then listed again: defaults stay.
  saveConnectorModelProviders([provider({ problem: "gateway is slow" })]);
  assert.equal(find().claudeEffort, "high");
  assert.equal(find().connectorProblem, "gateway is slow");
  saveConnectorModelProviders([]);
  assert.equal(find(), undefined);
  saveConnectorModelProviders([provider()]);
  assert.equal(find().model, "claude-opus-4-1");

  // A session on it starts with them.
  const run = profileConfigForSession("", {
    id: "sess_1",
    provider: "claude",
    profileId: "gw_default",
  });
  assert.equal(run.model, "claude-opus-4-1");
  assert.equal(claudeEffort({}, run), "high");
  assert.equal(claudeEffort({ claudeEffort: "low" }, run), "low");
  assert.equal(
    agentProfilesForWorkspace({ id: "d", lastSeenLabel: "now" }, "", []).find(
      (row) => row.id === "gw_default",
    ).claudeEffort,
    "high",
  );
});

test("a saved model the provider stops offering gives way to the provider's own", () => {
  saveConnectorModelProviders([provider()]);
  save({ model: "claude-opus-4-1", claudeEffort: "max" });
  saveConnectorModelProviders([provider({ models: ["claude-sonnet-4-5"] })]);
  assert.equal(find().model, "claude-sonnet-4-5");
  assert.equal(find().claudeEffort, "max");
});

test("clearing every default removes the entry; a model it does not offer is refused", () => {
  saveConnectorModelProviders([provider()]);
  assert.throws(() => save({ model: "gpt-5" }), /does not offer/);
  save({ claudeEffort: "high" });
  assert.ok(existsSync(externalProfileDefaultsPath()));
  save({});
  assert.equal(find().claudeEffort, undefined);
  assert.equal(find().model, "claude-sonnet-4-5");
});

test("defaults cannot be saved for a provider the device does not have", () => {
  assert.throws(() => save({ claudeEffort: "high" }), /not on this device/);
});

test("the model catalog of a connector's provider is the models it lists", async () => {
  saveConnectorModelProviders([provider()]);
  const models = await listAgentModelsConfig(
    {
      id: "gw_default",
      label: "Gateway · default",
      runtime: "claude",
      connectionType: "external",
    },
    "",
  );
  assert.deepEqual(
    models.map((row) => row.id),
    ["claude-sonnet-4-5", "claude-opus-4-1"],
  );
});
