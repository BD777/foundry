// The person's defaults for a connector's model provider (DEV-135): set
// through the same upsert as a login's, kept apart from the connection the
// connector re-lists, and applied to the sessions it starts.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { saveConnectorModelProviders } from "../dist/harness/connector-model-providers.js";
import {
  externalConnectionAsGiven,
  externalProfileDefaultsPath,
} from "../dist/harness/external-profile-defaults.js";
import {
  providerCheckFingerprint,
  providerChecksPath,
} from "../dist/harness/provider-check-state.js";
import { checkFailureReason } from "../dist/session/provider-check.js";
import { writeJSON } from "../dist/platform/storage.js";
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

const projected = () =>
  agentProfilesForWorkspace({ id: "d", lastSeenLabel: "now" }, "", []).find(
    (row) => row.id === "gw_default",
  );

test.afterEach(() => {
  saveConnectorModelProviders([]);
  rmSync(externalProfileDefaultsPath(), { force: true });
  rmSync(providerChecksPath(), { force: true });
});

test("saving a default model keeps the connection's passed check", () => {
  saveConnectorModelProviders([provider()]);
  // Recorded before any default existed, as a pre-DEV-135 worker did.
  const checkedAt = "2026-11-05T10:00:00.000Z";
  writeJSON(providerChecksPath(), {
    gw_default: {
      status: "passed",
      checkedAt,
      fingerprint: providerCheckFingerprint(find(), []),
    },
  });
  assert.deepEqual(projected().check, { status: "passed", checkedAt });

  save({ model: "claude-opus-4-1", claudeEffort: "high" });
  assert.equal(projected().model, "claude-opus-4-1");
  assert.equal(projected().status, "healthy");
  assert.deepEqual(projected().check, { status: "passed", checkedAt });
  // A check runs on the connection as the connector gave it.
  assert.equal(externalConnectionAsGiven(find()).model, "claude-sonnet-4-5");
  assert.equal(externalConnectionAsGiven(find()).claudeEffort, undefined);
  assert.equal(find().model, "claude-opus-4-1");

  // A different connection (another identity) still needs its own check.
  saveConnectorModelProviders([
    provider({
      externalConnection: {
        executable: "/bin/true",
        args: ["default"],
        identity: "person-b",
      },
    }),
  ]);
  assert.deepEqual(projected().check, { status: "pending" });
  assert.equal(projected().statusDetail, "Not checked yet.");
});

test("a provider's limit reached is a used-up quota, not a broken provider", () => {
  for (const message of [
    "Claude Code returned an error result: You've hit your weekly limit · resets 2pm (America/Toronto)",
    "Claude AI usage limit reached|1793980800",
    "API Error: 429 rate_limit_error",
    "Error code 429: Too Many Requests",
    "You exceeded your current quota, please check your plan",
    "insufficient_quota",
  ])
    assert.equal(checkFailureReason(message), "quota_exhausted", message);
  for (const message of [
    "Invalid API key · Please run /login",
    "The agent did not answer within two minutes.",
    "model claude-opus-4-1 not found (request 4291)",
  ])
    assert.equal(checkFailureReason(message), undefined, message);
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
