import assert from "node:assert/strict";
import test from "node:test";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { describeConnectionReport } from "../dist/connection-reports.js";
import { scanAnswer } from "../dist/daemon/handlers/skills.js";
import { WorkspaceRoster } from "../dist/daemon/workspace-roster.js";
import {
  forgetSentSections,
  sectionedRegistration,
  sentSectionsInFull,
} from "../dist/registration-sections.js";
import { SendMeter, meterSocket } from "../dist/send-meter.js";
import { ReliableSessionTransport } from "../dist/transport.js";

function socket() {
  const messages = [];
  return {
    messages,
    readyState: 1,
    send(value, callback) {
      messages.push(JSON.parse(value));
      callback?.();
    },
  };
}

test("the send meter counts the first minutes by type, replays, peaks and stalls", () => {
  let now = 1_000;
  const meter = new SendMeter(60_000, () => now);
  meter.opened();
  meter.sent("workspace_ready", 20_000);
  meter.sent("workspace_ready", 18_000);
  meter.sent("hello", 19_000);
  meter.sent("session_event", 500, true);
  now += 61_000;
  meter.sent("skills_scanned", 70_000);
  meter.sample(0, 3);
  meter.sample(4_000, 10);
  now += 5_000;
  meter.sample(5_000, 12);
  meter.progress();
  now += 1_000;
  meter.sample(1_000, 2);
  meter.sample(0, 0);
  const report = meter.report();
  assert.deepEqual(report.sentAfterOpen, {
    windowMs: 60_000,
    types: [
      { type: "workspace_ready", count: 2, bytes: 38_000 },
      { type: "hello", count: 1, bytes: 19_000 },
      { type: "session_event", count: 1, bytes: 500 },
    ],
  });
  assert.deepEqual(report.replayed, { count: 1, bytes: 500 });
  assert.deepEqual(report.outboxPeak, { queued: 12, bufferedBytes: 5_000 });
  assert.equal(report.longestSendStallMs, 5_000);
  assert.match(
    describeConnectionReport({
      openedAt: "",
      closedAt: "",
      durationMs: 1,
      closedBy: "network",
      compressed: true,
      ...report,
    }),
    /compressed, first 60s sent \[workspace_ready 2x 37KB hello 19KB session_event 500B\], replayed 1 outbox messages 500B, outbox peak 12 queued 5KB on socket, longest send stall 5s/,
  );
  assert.deepEqual(new SendMeter().report(), {});
});

test("outbox messages unacknowledged on an earlier socket count as replayed", () => {
  const transport = new ReliableSessionTransport();
  const first = socket();
  transport.bind(first);
  transport.send(daemonMessageTypes.sessionCompleted, { sessionId: "s" });
  transport.unbind(first);
  const second = socket();
  const meter = new SendMeter();
  meterSocket(second, meter);
  transport.bind(second);
  transport.send(daemonMessageTypes.sessionStarted, { sessionId: "t" });
  const report = meter.report();
  assert.equal(report.replayed.count, 1);
  assert.deepEqual(
    report.sentAfterOpen.types.map((entry) => entry.type).sort(),
    [daemonMessageTypes.sessionCompleted, daemonMessageTypes.sessionStarted],
  );
});

test("a section sent in full is left out of the next registration", () => {
  forgetSentSections();
  const registration = {
    device: { id: "dev" },
    providerHealth: [{ provider: "claude" }],
    agentProfiles: [],
    assets: [{ id: "a" }],
    agents: [],
    workspaceFiles: [],
  };
  const first = sectionedRegistration(registration);
  assert.equal(first.slim, undefined);
  assert.deepEqual(Object.keys(first.whole.sections).sort(), [
    "device",
    "workspace",
  ]);
  sentSectionsInFull(first.whole.sections);

  const next = sectionedRegistration(registration);
  assert.deepEqual(next.slim.omittedSections, ["device", "workspace"]);
  assert.equal(next.slim.providerHealth, undefined);
  assert.equal(next.slim.assets, undefined);
  assert.deepEqual(next.slim.device, { id: "dev" });

  // Changed health is sent; the unchanged workspace is still left out.
  const changed = sectionedRegistration({
    ...registration,
    providerHealth: [{ provider: "codex" }],
  });
  assert.deepEqual(changed.slim.omittedSections, ["workspace"]);
  assert.deepEqual(changed.slim.providerHealth, [{ provider: "codex" }]);
});

test("a registration the server cannot fill in goes again whole", () => {
  forgetSentSections();
  const link = socket();
  const roster = new WorkspaceRoster(link, "", undefined);
  const registration = {
    device: { id: "dev" },
    providerHealth: [{ provider: "claude" }],
    assets: [],
  };
  roster.sendRegistration(daemonMessageTypes.hello, registration, "h1");
  assert.ok(link.messages[0].payload.sections);
  assert.equal(link.messages[0].payload.omittedSections, undefined);
  assert.deepEqual(link.messages[0].payload.providerHealth, [
    { provider: "claude" },
  ]);
  roster.sendRegistration(
    daemonMessageTypes.workspaceReady,
    registration,
    "w1",
  );
  const slim = link.messages[1];
  assert.deepEqual(slim.payload.registration.omittedSections, [
    "device",
    "workspace",
  ]);
  assert.equal(slim.payload.registration.providerHealth, undefined);

  assert.equal(roster.registrationNeeded("w1"), true);
  const whole = link.messages[2];
  assert.equal(whole.type, daemonMessageTypes.workspaceReady);
  assert.equal(whole.id, "w1_whole");
  assert.deepEqual(whole.payload.registration.providerHealth, [
    { provider: "claude" },
  ]);
  assert.equal(whole.payload.registration.omittedSections, undefined);
  // Asked once; an unknown id is not ours.
  assert.equal(roster.registrationNeeded("w1"), false);
  roster.close();
});

test("registrations wait for a hello the server has to ask for whole", () => {
  forgetSentSections();
  const link = socket();
  const roster = new WorkspaceRoster(link, "", undefined);
  const registration = { device: { id: "dev" }, providerHealth: [] };
  roster.sendRegistration(daemonMessageTypes.hello, registration, "h0");
  roster.registrationTaken("h0");
  // A restarted server lost what the first hello carried.
  roster.sendRegistration(daemonMessageTypes.hello, registration, "h1");
  roster.sendRegistration(
    daemonMessageTypes.workspaceReady,
    registration,
    "w1",
  );
  assert.deepEqual(
    link.messages.map((message) => message.id),
    ["h0", "h1"],
  );
  assert.equal(roster.registrationNeeded("h1"), true);
  assert.equal(link.messages.at(-1).id, "h1_whole");
  roster.registrationTaken("h1_whole");
  assert.equal(link.messages.at(-1).id, "w1");
  roster.close();
});

test("a skill scan answer the server keeps goes as its digest only", () => {
  const answer = { skills: [{ dirName: "one" }], tools: { git: true } };
  const whole = scanAnswer(answer, undefined);
  assert.equal(typeof whole.digest, "string");
  assert.deepEqual(whole.skills, answer.skills);
  assert.deepEqual(scanAnswer(answer, whole.digest), {
    unchanged: true,
    digest: whole.digest,
  });
  assert.deepEqual(scanAnswer(answer, "older").skills, answer.skills);
});
