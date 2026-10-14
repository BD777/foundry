import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRoster } from "../dist/daemon/workspace-roster.js";
import { SessionExecutionRegistry } from "../dist/session-state.js";
import {
  initWorkspace,
  readWorkspace,
  writeRegistry,
} from "../dist/workspaces.js";

function openSocket() {
  const sent = [];
  return {
    sent,
    socket: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
  };
}

test("a device with no workspace still reports its profiles and provider health", () => {
  writeRegistry([]);
  const { sent, socket } = openSocket();
  new WorkspaceRoster(
    socket,
    "",
    new SessionExecutionRegistry(),
  ).reportDevice();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "workspace_ready");
  const { registration } = sent[0].payload;
  assert.equal(registration.workspace, undefined);
  assert.ok(registration.device.id);
  assert.ok(Array.isArray(registration.providerHealth));
  assert.ok(registration.agentProfiles.length > 0);
  assert.ok(
    registration.agentProfiles.every(
      (profile) => profile.deviceId === registration.device.id,
    ),
  );
});

test("with workspaces the device report comes first, then each workspace for its agents", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "foundry-device-report-")),
  );
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    writeRegistry([]);
  });
  const [first, second] = ["first", "second"].map((name) => {
    initWorkspace(join(root, name));
    return readWorkspace(join(root, name));
  });
  const { sent, socket } = openSocket();
  new WorkspaceRoster(
    socket,
    "",
    new SessionExecutionRegistry(),
  ).reportDevice();

  assert.deepEqual(
    sent.map((envelope) => envelope.payload.registration.workspace?.id),
    [undefined, first.id, second.id],
  );
  const [device, ...workspaces] = sent.map(
    (envelope) => envelope.payload.registration,
  );
  for (const registration of workspaces) {
    assert.deepEqual(registration.agentProfiles, device.agentProfiles);
    assert.equal(registration.agents.length, device.agentProfiles.length);
  }
});
