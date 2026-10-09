import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { applyFoundryStreamEvent } =
  await import("../src/app/foundry-data-projection.ts");

test("a device status event updates the device list at once", () => {
  const data = {
    devices: [
      { id: "dev_a", label: "a", status: "connected", lastSeenLabel: "online" },
      { id: "dev_b", label: "b", status: "connected", lastSeenLabel: "online" },
    ],
  };
  const offline = applyFoundryStreamEvent(data, {
    type: "device_status_changed",
    payload: { workspaceId: "ws", deviceId: "dev_b", status: "disconnected" },
  });
  assert.equal(offline.devices[1].status, "disconnected");
  assert.equal(offline.devices[1].lastSeenLabel, "offline");
  assert.equal(offline.devices[0], data.devices[0]);
  const unknown = applyFoundryStreamEvent(data, {
    type: "device_status_changed",
    payload: { workspaceId: "ws", deviceId: "dev_x", status: "connected" },
  });
  assert.equal(unknown, data, "an unknown device changes nothing");
});
