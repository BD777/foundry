import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionSelection,
  connectionUsage,
  deviceConnectionSelection,
  isModelConnection,
} from "../src/lib/model-connections.ts";

test("assignment preserves all other connections and historical official bindings", () => {
  const bindings = [
    { deviceId: "a", profileId: "legacy-official", enabled: true },
    { deviceId: "a", profileId: "relay", enabled: true },
    { deviceId: "b", profileId: "other-device", enabled: true },
  ];
  assert.deepEqual(connectionSelection(bindings, "a", "new", true), [
    "legacy-official",
    "relay",
    "new",
  ]);
  assert.deepEqual(connectionSelection(bindings, "a", "relay", false), [
    "legacy-official",
  ]);
});
test("official accounts and connections have different ownership", () => {
  assert.equal(isModelConnection({ authMode: "official" }), false);
  assert.equal(isModelConnection({ connectionType: "local_login" }), false);
  assert.equal(
    isModelConnection({
      authMode: "custom",
      connectionType: "openai_compatible",
    }),
    true,
  );
});
test("global status describes configuration and assignment, not connectivity", () => {
  const connection = { id: "p", hasCredential: true };
  assert.equal(connectionUsage(connection, []), "Configured · Not assigned");
  assert.equal(
    connectionUsage({ ...connection, hasCredential: false }, []),
    "No key configured · Not assigned",
  );
  assert.equal(
    connectionUsage(connection, [
      { profileId: "p", deviceId: "a", enabled: true },
    ]),
    "Configured · 1 device",
  );
  assert.equal(
    connectionUsage({ ...connection, hasCredential: false }, [
      { profileId: "p", deviceId: "a", enabled: true },
    ]),
    "No key configured · 1 device",
  );
});

test("dialog save preserves bindings outside the selectable set", () => {
  const bindings = [
    { deviceId: "a", profileId: "legacy-official", enabled: true },
    { deviceId: "a", profileId: "conn-1", enabled: true },
    { deviceId: "a", profileId: "conn-2", enabled: false },
    { deviceId: "b", profileId: "other-device", enabled: true },
  ];
  // The picker shows conn-1/conn-2/conn-3; the user enables conn-1 and
  // conn-3, leaves conn-2 off. The legacy official binding must survive, and
  // another device's set must be untouched by inclusion.
  assert.deepEqual(
    deviceConnectionSelection(
      bindings,
      "a",
      ["conn-1", "conn-2", "conn-3"],
      ["conn-1", "conn-3"],
    ).sort(),
    ["conn-1", "conn-3", "legacy-official"],
  );
  // Deselecting everything selectable still keeps the hidden legacy binding.
  assert.deepEqual(
    deviceConnectionSelection(bindings, "a", ["conn-1", "conn-2"], []),
    ["legacy-official"],
  );
});
