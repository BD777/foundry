import assert from "node:assert/strict";
import test from "node:test";
import {
  pickerSetupRows,
  readyAgent,
  setupSteps,
} from "../src/features/chat/external-connection-setup-model.ts";

const offer = (stage, extra = {}) => ({
  profileId: "company",
  label: "Company · default",
  runtime: "claude",
  setup: { command: "install", signIn: "device_code" },
  sourceDevices: [{ id: "dev_other", label: "laptop" }],
  stage,
  ...extra,
});

const detail = (stage, extra = {}) => ({
  offer: offer(stage),
  device: { id: "dev_1", label: "server", online: true },
  live: true,
  remote: { available: true },
  ...extra,
});

const states = (steps) => steps.map((step) => `${step.key}:${step.state}`);

test("the picker offers one action per connection not ready here", () => {
  const rows = pickerSetupRows(
    [
      offer("not_set_up"),
      offer("check_failed", { profileId: "other", detail: "quota exceeded" }),
      offer("ready", { profileId: "ready" }),
    ],
    [],
    "dev_1",
  );
  assert.deepEqual(
    rows.map((row) => [row.profileId, row.actionLabel]),
    [
      ["company", "Set up…"],
      ["other", "Retry…"],
    ],
  );
  assert.equal(rows[0].detail, "Not set up on this device");
  // The failure reason is shown verbatim.
  assert.equal(rows[1].detail, "Check failed: quota exceeded");
});

test("a connection the device already lists as usable is not offered again", () => {
  const agent = {
    id: "agent_company",
    deviceId: "dev_1",
    profileId: "company",
    status: "healthy",
  };
  assert.deepEqual(pickerSetupRows([offer("unchecked")], [agent], "dev_1"), []);
  assert.equal(readyAgent([agent], "dev_1", "company"), agent);
  assert.equal(readyAgent([agent], "dev_2", "company"), undefined);
});

test("steps move on from registration and check alone", () => {
  assert.deepEqual(states(setupSteps(detail("not_set_up"), false)), [
    "run:needed",
    "installed:needed",
    "signIn:needed",
    "registered:needed",
    "checked:needed",
  ]);
  // A gateway that never reports progress: registration marks every step
  // before it done, and the check runs.
  assert.deepEqual(states(setupSteps(detail("unchecked"), true)), [
    "run:done",
    "installed:done",
    "signIn:done",
    "registered:done",
    "checked:running",
  ]);
  assert.deepEqual(
    states(setupSteps(detail("check_failed"), false)).at(-1),
    "checked:failed",
  );
  assert.ok(
    states(setupSteps(detail("ready"), false)).every((step) =>
      step.endsWith(":done"),
    ),
  );
});

test("reported progress places the current step", () => {
  const waiting = detail("waiting_sign_in", {
    progress: { profileId: "company", state: "waiting_sign_in", updatedAt: "" },
  });
  assert.deepEqual(states(setupSteps(waiting, false)), [
    "run:done",
    "installed:done",
    "signIn:running",
    "registered:needed",
    "checked:needed",
  ]);
  const failed = detail("setup_failed", {
    progress: { profileId: "company", state: "failed", updatedAt: "" },
  });
  assert.equal(states(setupSteps(failed, false))[1], "installed:failed");
  // No sign-in step when the gateway signs in without the person.
  const quiet = detail("in_progress");
  quiet.offer.setup.signIn = "none";
  assert.deepEqual(
    setupSteps(quiet, false).map((step) => step.key),
    ["run", "installed", "registered", "checked"],
  );
});
