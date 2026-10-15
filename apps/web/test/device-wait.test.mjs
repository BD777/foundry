import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { deviceAwaitedBy, offlineDevice } =
  await import("../src/lib/device-wait.ts");
const { agentSessionMessageText } =
  await import("../src/features/chat/chat-session-model.ts");
const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { assistantActivity } =
  await import("../src/features/personal-agent/assistant-model.ts");
const { i18n } = await import("../src/i18n/index.ts");

const laptop = { id: "dev_laptop", label: "Laptop", status: "disconnected" };
const desktop = { id: "dev_desktop", label: "Desktop", status: "connected" };
const devices = [laptop, desktop];

function session(extra = {}) {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    deviceId: laptop.id,
    status: "queued",
    title: "Fix the build",
    prompt: "Fix the build",
    ...extra,
  };
}

test("only a listed device that is not connected is offline", () => {
  assert.equal(offlineDevice(laptop.id, devices), laptop);
  assert.equal(offlineDevice(desktop.id, devices), undefined);
  assert.equal(offlineDevice("dev_unknown", devices), undefined);
  assert.equal(offlineDevice(undefined, devices), undefined);
});

test("a queued session waits for its offline device, nothing else does", () => {
  assert.equal(deviceAwaitedBy(session(), devices), laptop);
  assert.equal(
    deviceAwaitedBy(session({ deviceId: desktop.id }), devices),
    undefined,
  );
  assert.equal(
    deviceAwaitedBy(session({ status: "running" }), devices),
    undefined,
  );
  assert.equal(deviceAwaitedBy(undefined, devices), undefined);
});

test("a queued session's placeholder names the device it waits for", () => {
  const blocking = session({
    id: "sess_0",
    status: "running",
    title: "Earlier work",
  });
  assert.equal(
    agentSessionMessageText(session(), { devices, sessions: [blocking] }),
    i18n.t("chat:session.waitingForDevice", { device: "Laptop" }),
  );
  // Online, the queued session waits for the device's current task.
  assert.equal(
    agentSessionMessageText(session({ deviceId: desktop.id }), {
      devices,
      sessions: [{ ...blocking, deviceId: desktop.id }],
    }),
    i18n.t("chat:session.waitingForTask", { title: "Earlier work" }),
  );
  assert.equal(
    agentSessionMessageText(session()),
    i18n.t("chat:session.delivered"),
  );
});

const at = (second) =>
  new Date(Date.UTC(2026, 9, 15, 1, 0, second)).toISOString();
const event = (id, second, label, extra = {}) => ({
  id,
  sessionId: "sess_1",
  at: at(second),
  label,
  detail: "",
  level: "info",
  ...extra,
});
const input = (id, second, text) =>
  event(`evt_${id}`, second, "User message", {
    message: { id, kind: "user", text },
  });
const waitNotice = (second) =>
  event(`evt_wait_${second}`, second, "Waiting for device", {
    detail: "Laptop is offline. This waits and starts by itself.",
    level: "warning",
  });

test("a session waiting for its offline device shows that, never a running timer", () => {
  const thread = (extra) => ({
    id: "sess_1",
    sessions: [session({ provider: "claude", ...extra })],
  });
  for (const events of [
    [input("in_1", 1, "Fix the build")],
    [input("in_1", 1, "Fix the build"), waitNotice(2)],
    [
      input("in_1", 1, "Fix the build"),
      event("answer", 3, "Response stream", { detail: "Done." }),
      input("in_2", 5, "Now the tests"),
      waitNotice(6),
    ],
  ]) {
    const messages = chatMessagesForThread(thread({ events }), { devices });
    const last = messages.at(-1);
    assert.equal(last.kind, "waiting", JSON.stringify(messages));
    assert.equal(
      last.title,
      i18n.t("chat:transcript.waitingForDevice", { device: "Laptop" }),
    );
    assert.equal(messages.at(-2).role, "user");
    assert.ok(
      messages.every(
        (message) => !message.streaming && message.startedAt === undefined,
      ),
      JSON.stringify(messages),
    );
  }
  // Back online, the same queued session is about to run, and the earlier
  // notice stays in its history.
  const online = chatMessagesForThread(
    thread({
      deviceId: desktop.id,
      events: [input("in_1", 1, "Fix the build"), waitNotice(2)],
    }),
    { devices },
  );
  assert.equal(online.at(-1).kind, "process");
  assert.equal(online.at(-1).streaming, true);
  assert.ok(online.every((message) => message.kind !== "waiting"));
});

test("the assistant waits for its offline computer instead of working", () => {
  const latest = session({ id: "sess_pa" });
  assert.deepEqual(assistantActivity(latest, devices, false), {
    waitingFor: laptop,
  });
  assert.equal(
    assistantActivity({ ...latest, status: "running" }, devices, false),
    "working",
  );
  assert.equal(
    assistantActivity({ ...latest, status: "running" }, devices, true),
    undefined,
  );
  assert.equal(
    assistantActivity({ ...latest, deviceId: desktop.id }, devices, false),
    "working",
  );
  assert.equal(
    assistantActivity({ ...latest, status: "completed" }, devices, false),
    undefined,
  );
  assert.equal(assistantActivity(undefined, devices, false), undefined);
});
