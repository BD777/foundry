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

test("a device event keeps what the server told only this viewer", () => {
  const data = {
    devices: [
      {
        id: "dev_a",
        label: "a",
        status: "connected",
        lastSeenLabel: "online",
        owned: true,
        outsideFilesOff: true,
      },
    ],
  };
  const device = {
    id: "dev_a",
    label: "a2",
    status: "connected",
    lastSeenLabel: "online",
    owned: false,
    outsideFilesOff: false,
  };
  const next = applyFoundryStreamEvent(data, {
    type: "device_status_changed",
    payload: {
      workspaceId: "ws",
      deviceId: "dev_a",
      status: "connected",
      device,
    },
  });
  assert.equal(next.devices[0].label, "a2");
  assert.equal(next.devices[0].owned, true);
  assert.equal(
    next.devices[0].outsideFilesOff,
    true,
    "the owner's switch stays off: links outside the workspace stay text",
  );
  const { outsideFilesOff: _off, ...on } = data.devices[0];
  const shown = applyFoundryStreamEvent(
    { devices: [on] },
    {
      type: "device_status_changed",
      payload: {
        workspaceId: "ws",
        deviceId: "dev_a",
        status: "connected",
        device,
      },
    },
  );
  assert.equal("outsideFilesOff" in shown.devices[0], false);
});

test("a read keeps a streamed device but takes this viewer's own fields", async () => {
  const { deviceLoadedMerges } =
    await import("../src/app/projections/devices.ts");
  const streamed = {
    id: "dev_a",
    label: "new",
    status: "connected",
    owned: true,
  };
  const loaded = { ...streamed, label: "old", outsideFilesOff: true };
  const [device] = deviceLoadedMerges.devices(
    { devices: [streamed] },
    { devices: [loaded] },
    { devices: new Set(["dev_a"]) },
  );
  assert.equal(device.label, "new");
  assert.equal(device.outsideFilesOff, true);
});
