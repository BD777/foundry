import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeOperations,
  computerUseOperations,
  resourceOperationsCapability,
} from "@bd777/foundry-protocol";
import {
  createCuaDriverDetector,
  createCuaDriverProvider,
  installResourceBackend,
  mapComputerUseAction,
  parseCuaDriverPermissions,
  ProviderRegistry,
  cuaDriverGrantRun,
  cuaDriverPermissionWatchActive,
  openCuaDriverSettings,
  requestCuaDriverAccess,
  resetCuaDriverGrantRun,
  stopCuaDriverPermissionWatch,
  ResourceOperations,
} from "../dist/resources/index.js";
import {
  convertToolResult,
  cuaDriverOperations,
  structuredText,
} from "../dist/resources/providers/cua-driver.js";
import { daemonCapabilities } from "../dist/workspace-ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeDriver = join(here, "fixtures", "fake-cua-driver.mjs");
const captured = JSON.parse(
  readFileSync(join(here, "fixtures", "cua-driver-results.json"), "utf8"),
);
const key = "computer_use/macos/console:501";

function harness({ drop = "", maxImageBytes, idleMs, notify } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "fake-cua-"));
  const log = join(folder, "calls.jsonl");
  const provider = createCuaDriverProvider({
    command: () => ({ command: process.execPath, args: [fakeDriver] }),
    env: { ...process.env, FAKE_CUA_LOG: log, FAKE_CUA_DROP: drop },
    encodeImage: async (data) => ({ data, mimeType: "image/jpeg" }),
    ...(maxImageBytes ? { maxImageBytes } : {}),
  });
  const operations = new ResourceOperations({
    providers: new ProviderRegistry([provider]),
    platform: "darwin",
    ...(idleMs ? { idleMs } : {}),
    ...(notify ? { notify } : {}),
  });
  const entries = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const calls = () => entries().filter((entry) => entry.event === "start");
  const operate = (actions, extra = {}) =>
    operations.operate({
      resourceId: "res_1",
      key,
      type: "computer_use",
      backend: "cua-driver",
      leaseId: "lease_1",
      generation: 1,
      deadlineMs: 10_000,
      actions,
      ...extra,
    });
  const done = async () => {
    await operations.closeAll();
    rmSync(folder, { recursive: true, force: true });
  };
  return { operations, operate, calls, entries, done };
}

test("list_windows and list_apps pass cua-driver's structured records on", async (t) => {
  const h = harness();
  t.after(h.done);
  const listed = await h.operate([{ op: "list_windows" }, { op: "list_apps" }]);
  const [windows, apps] = listed.results;
  assert.ok(windows.ok && apps.ok, JSON.stringify(listed.results));
  const [summary, json] = windows.text.split("\n");
  assert.equal(summary, "Found 2 window(s).");
  assert.deepEqual(JSON.parse(json), captured.list_windows.structuredContent);
  assert.deepEqual(
    JSON.parse(apps.text.slice(apps.text.indexOf("\n{") + 1)),
    captured.list_apps.structuredContent,
  );
});

test("structured results stay parseable JSON under the size bound", async () => {
  const elements = Array.from({ length: 2000 }, (_, index) => ({
    element_token: `snap9:${index}`,
    role: "AXButton",
    label: `Button ${index}`,
  }));
  const tree = "- [0] AXWindow";
  const result = await convertToolResult(
    "get_ui_tree",
    {
      content: [{ type: "text", text: tree }],
      structuredContent: {
        window_id: 7,
        pid: 42,
        tree_markdown: tree,
        elements,
        _note: "Prefer `elements`",
      },
    },
    async (data, mimeType) => ({ data, mimeType }),
  );
  assert.ok(result.ok);
  assert.ok(result.text.startsWith(`${tree}\n{`));
  const parsed = JSON.parse(result.text.slice(tree.length + 1));
  assert.equal(parsed.tree_markdown, undefined, "the text already has it");
  assert.equal(parsed._note, undefined);
  assert.equal(parsed.window_id, 7);
  assert.equal(parsed.elements_truncated.total, 2000);
  assert.equal(parsed.elements.length, parsed.elements_truncated.returned);
  assert.ok(parsed.elements.length > 100);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) <= 64 * 1024);

  const blob = structuredText({ blob: "x".repeat(100) }, "", 40);
  assert.match(blob, /^\{"blob":"x+\n\[structured result truncated: 111 bytes/);
  assert.equal(structuredText({ _note: "only advice" }, ""), "");
});

test("operations map onto cua-driver tools with its argument names", async (t) => {
  const h = harness();
  t.after(h.done);
  const shot = await h.operate([{ op: "screenshot" }]);
  assert.equal(shot.opened, true);
  assert.equal(shot.results[0].ok, true);
  const [desktop] = shot.results[0].images;
  assert.equal(desktop.mimeType, "image/jpeg");
  assert.deepEqual([desktop.width, desktop.height, desktop.scale], [2, 1, 1]);
  assert.match(desktop.frameId, /^frame_/);

  const window = await h.operate([
    {
      op: "screenshot",
      args: { pid: 42, window_id: 7, max_image_dimension: 4000 },
    },
    { op: "click", args: { element_token: "snap1:3", pid: 42, window_id: 7 } },
    {
      op: "click",
      args: { x: 10, y: 20.5, pid: 42, window_id: 7, count: 2, button: "left" },
    },
    { op: "key", args: { key: "return", modifiers: ["cmd"], pid: 42 } },
    {
      op: "drag",
      args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, window_id: 7 },
    },
    { op: "open_app", args: { bundle_id: "com.apple.TextEdit" } },
    { op: "activate_window", args: { pid: 42, window_id: 7 } },
    { op: "get_ui_tree", args: { pid: 42, window_id: 7, query: "Save" } },
    { op: "screen_size" },
    { op: "wait", args: { ms: 10 } },
  ]);
  assert.equal(window.opened, undefined, "the lease's session is reused");
  assert.ok(
    window.results.every((result) => result.ok),
    JSON.stringify(window.results),
  );
  const [frame] = window.results[0].images;
  assert.deepEqual(
    [frame.width, frame.height, frame.scale, frame.frameId],
    [4, 2, 2, "snap1"],
  );
  assert.equal(window.results[8].text, '{"width":1512,"height":982}');
  assert.equal(window.results[9].text, "waited 10 ms");
  assert.deepEqual(
    h.calls().map(({ tool, args }) => [tool, args]),
    [
      ["get_desktop_state", { max_image_dimension: 1280 }],
      [
        "get_window_state",
        {
          pid: 42,
          window_id: 7,
          max_image_dimension: 1280,
          include_screenshot: true,
          include_accessibility_tree: false,
        },
      ],
      ["click", { element_token: "snap1:3", pid: 42, window_id: 7 }],
      [
        "click",
        { x: 10, y: 20.5, pid: 42, window_id: 7, count: 2, button: "left" },
      ],
      ["press_key", { key: "return", modifiers: ["cmd"], pid: 42 }],
      [
        "drag",
        {
          from_x: 1,
          from_y: 2,
          to_x: 3,
          to_y: 4,
          window_id: 7,
          delivery_mode: "foreground",
        },
      ],
      ["launch_app", { bundle_id: "com.apple.TextEdit" }],
      ["bring_to_front", { pid: 42, window_id: 7 }],
      [
        "get_window_state",
        {
          pid: 42,
          window_id: 7,
          query: "Save",
          include_screenshot: false,
          include_accessibility_tree: true,
          max_image_dimension: 1280,
        },
      ],
      ["get_screen_size", {}],
    ],
  );
});

test("argument checks: unknown ops, missing or mistyped args, wait capped", () => {
  const code = (action) => {
    try {
      mapComputerUseAction(action);
      return "ok";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(code({ op: "teleport" }), "unknown_op");
  assert.equal(code({ op: "toString" }), "unknown_op");
  assert.equal(code({ op: "key", args: {} }), "invalid_args");
  assert.equal(code({ op: "click", args: { x: 1 } }), "invalid_args");
  assert.equal(code({ op: "click", args: { x: "1", y: 2 } }), "invalid_args");
  assert.equal(
    code({ op: "click", args: { x: 1, y: 2, target: "x" } }),
    "invalid_args",
  );
  assert.equal(code({ op: "screenshot", args: { pid: 1 } }), "invalid_args");
  assert.equal(code({ op: "hotkey", args: { keys: ["cmd"] } }), "invalid_args");
  assert.equal(
    code({ op: "scroll", args: { direction: "sideways" } }),
    "invalid_args",
  );
  assert.equal(
    code({ op: "drag", args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 } }),
    "invalid_args",
  );
  assert.equal(
    code({
      op: "drag",
      args: {
        from_x: 1,
        from_y: 2,
        to_x: 3,
        to_y: 4,
        window_id: 1,
        delivery_mode: "background",
      },
    }),
    "invalid_args",
  );
  assert.deepEqual(
    mapComputerUseAction({ op: "wait", args: { ms: 999_999 } }),
    {
      kind: "wait",
      ms: 5000,
    },
  );
  assert.equal(
    mapComputerUseAction({
      op: "get_ui_tree",
      args: { pid: 1, window_id: 2, include_screenshot: true },
    }).args.include_screenshot,
    true,
  );
});

test("a batch stops at the first failure; errors keep their codes", async (t) => {
  const h = harness({ drop: "set_value" });
  t.after(h.done);
  const unknown = await h.operate([
    { op: "list_apps" },
    { op: "teleport" },
    { op: "list_apps" },
  ]);
  assert.deepEqual(
    unknown.results.map((result) => [result.op, result.ok, result.errorCode]),
    [
      ["list_apps", true, undefined],
      ["teleport", false, "unknown_op"],
    ],
  );
  const missing = await h.operate([{ op: "type_text", args: {} }]);
  assert.equal(missing.results[0].errorCode, "invalid_args");
  assert.match(missing.results[0].error, /needs text/);
  const failed = await h.operate([{ op: "click", args: { x: 666, y: 1 } }]);
  assert.deepEqual(
    [
      failed.results[0].ok,
      failed.results[0].errorCode,
      failed.results[0].error,
    ],
    [false, "backend_error", "boom: no such window"],
  );
  const stale = await h.operate([{ op: "click", args: { x: 777, y: 1 } }]);
  assert.equal(stale.results[0].errorCode, "stale_frame");
  const unsupported = await h.operate([
    { op: "set_value", args: { value: "x" } },
  ]);
  assert.equal(unsupported.results[0].errorCode, "backend_unsupported");
  assert.match(unsupported.results[0].error, /set_value/);
});

test("an image over the limit is too_large", async (t) => {
  const h = harness({ maxImageBytes: 10 });
  t.after(h.done);
  const result = await h.operate([{ op: "screenshot" }]);
  assert.equal(result.results[0].errorCode, "too_large");
  assert.match(result.results[0].error, /max_image_dimension/);
});

test("fencing: older generations are refused; reset closes the old session", async (t) => {
  const notices = [];
  const h = harness({ notify: async (message) => void notices.push(message) });
  t.after(h.done);
  const first = await h.operate([{ op: "list_apps" }], { generation: 2 });
  assert.equal(first.opened, true);
  const older = await h.operate([{ op: "list_apps" }], {
    generation: 1,
    leaseId: "lease_0",
  });
  assert.equal(older.errorCode, "stale_lease");
  assert.deepEqual(older.results, []);

  const reset = await h.operations.reset({
    resourceId: "res_1",
    key,
    type: "computer_use",
    generation: 3,
    reason: "lease ended",
    notify: "Foundry released your screen",
  });
  assert.deepEqual(reset, { resourceId: "res_1", generation: 3 });
  assert.deepEqual(notices, ["Foundry released your screen"]);
  assert.equal(h.operations.fence(key), 3);
  const events = h
    .entries()
    .map((entry) => entry.event + (entry.tool ? `:${entry.tool}` : ""));
  assert.ok(events.includes("start:end_session"), events.join(","));
  assert.ok(events.includes("exit"), events.join(","));

  const late = await h.operate([{ op: "list_apps" }], { generation: 2 });
  assert.equal(late.errorCode, "stale_lease");
  const next = await h.operate([{ op: "list_apps" }], {
    generation: 3,
    leaseId: "lease_3",
  });
  assert.equal(next.opened, true);
  assert.equal(next.results[0].ok, true);
  assert.equal(
    new Set(h.calls().map((entry) => entry.pid)).size,
    2,
    "a new process",
  );
});

test("a reset aborts an older lease's operation in flight", async (t) => {
  const h = harness();
  t.after(h.done);
  const started = Date.now();
  const running = h.operate([{ op: "type_text", args: { text: "slow3000" } }], {
    generation: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await h.operations.reset({
    resourceId: "res_1",
    key,
    type: "computer_use",
    generation: 2,
    reason: "revoked",
  });
  const result = await running;
  assert.equal(result.results[0].errorCode, "stale_lease");
  assert.ok(Date.now() - started < 2500, "aborted, not waited out");
});

test("operations on one instance run one at a time, in order", async (t) => {
  const h = harness();
  t.after(h.done);
  await Promise.all([
    h.operate([{ op: "type_text", args: { text: "slow150" } }]),
    h.operate([{ op: "type_text", args: { text: "slow10" } }]),
    h.operate([{ op: "list_apps" }]),
  ]);
  const events = h
    .entries()
    .filter((entry) => entry.event === "start" || entry.event === "end")
    .map((entry) => `${entry.event}:${entry.tool}`);
  assert.deepEqual(events, [
    "start:type_text",
    "end:type_text",
    "start:type_text",
    "end:type_text",
    "start:list_apps",
    "end:list_apps",
  ]);
  assert.deepEqual(
    h.calls().map((entry) => entry.args.text ?? entry.tool),
    ["slow150", "slow10", "list_apps"],
  );
});

test("the deadline bounds a request; idle sessions close", async (t) => {
  const h = harness({ idleMs: 1000 });
  t.after(h.done);
  // Open the session first: the deadline then bounds the action only.
  await h.operate([{ op: "list_apps" }]);
  const late = await h.operate(
    [{ op: "type_text", args: { text: "slow2000" } }],
    { deadlineMs: 200 },
  );
  assert.equal(late.results[0].errorCode, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const again = await h.operate([{ op: "list_apps" }]);
  assert.equal(again.opened, true, "the idle session was closed");
});

test("requests a worker cannot run get a clear error", async () => {
  const provider = createCuaDriverProvider({ command: () => undefined });
  const request = {
    resourceId: "res_1",
    key,
    type: "computer_use",
    backend: "cua-driver",
    leaseId: "l",
    generation: 1,
    deadlineMs: 1000,
    actions: [{ op: "list_apps" }],
  };
  const linux = new ResourceOperations({
    providers: new ProviderRegistry([provider]),
    platform: "linux",
  });
  assert.equal(
    (await linux.operate(request)).errorCode,
    "unsupported_platform",
  );
  const mac = new ResourceOperations({
    providers: new ProviderRegistry([provider]),
    platform: "darwin",
  });
  assert.equal((await mac.operate(request)).errorCode, "backend_not_installed");
  assert.equal(
    (await mac.operate({ ...request, backend: "vnc" })).errorCode,
    "backend_unsupported",
  );
  assert.equal(
    (await mac.operate({ ...request, actions: [] })).errorCode,
    "invalid_request",
  );
});

test("the provider covers every protocol operation and the MCP tool's enum", () => {
  assert.deepEqual(
    [...cuaDriverOperations].sort(),
    [...computerUseOperations].sort(),
  );
  assert.ok(daemonCapabilities.includes(resourceOperationsCapability));
  const toolsPath = join(
    here,
    "..",
    "..",
    "..",
    "apps",
    "server",
    "internal",
    "httpapi",
    "mcp_tools.json",
  );
  if (!existsSync(toolsPath)) return;
  const tools = JSON.parse(readFileSync(toolsPath, "utf8"));
  const list = Array.isArray(tools) ? tools : (tools.tools ?? []);
  const operate = list.find((tool) => tool.name === "operate_resource");
  if (!operate) return;
  const enums = [];
  const walk = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (name === "op" && Array.isArray(node.enum)) enums.push(node.enum);
    for (const [child, value] of Object.entries(node)) walk(value, child);
  };
  walk(operate, "");
  assert.ok(enums.length > 0, "operate_resource has an op enum");
  for (const values of enums)
    assert.deepEqual(
      [...values].sort(),
      [...computerUseOperations, ...computeOperations].sort(),
    );
});

function detectContext(results) {
  const calls = [];
  return {
    calls,
    context: {
      signal: new AbortController().signal,
      platform: "darwin",
      env: { HOME: "/Users/p", PATH: "" },
      workspacePaths: () => [],
      exec: async (command, args, options) => {
        calls.push({ command, args, env: options?.env });
        const key = args.join(" ");
        return {
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          missing: false,
          ...(results[key] ?? {}),
        };
      },
    },
  };
}

test("the cua-driver detector climbs installed → configured → permitted, passively", async () => {
  const bin = "/Users/p/.local/bin/cua-driver";
  const detect = async (binary, results) => {
    const { context, calls } = detectContext(results);
    const [instance] = await createCuaDriverDetector({
      resolveBinary: () => binary,
      uid: () => 501,
    }).detect(context);
    return { instance, calls };
  };
  const absent = await detect(undefined, {});
  assert.equal(absent.instance.key, key);
  assert.equal(absent.instance.name, "macOS screen control");
  assert.deepEqual(absent.instance.readiness, {
    ready: false,
    level: "installed",
    reason: "cua-driver is not installed on this Mac.",
    missing: ["cua_driver_not_installed"],
  });
  assert.equal(absent.calls.length, 0);

  const stopped = await detect(bin, {
    "--version": { stdout: "cua-driver 0.34.1\n" },
    "permissions status --json": {
      stdout: JSON.stringify({
        daemon_running: false,
        status: "unknown",
        reason: "no daemon",
      }),
    },
  });
  assert.deepEqual(stopped.instance.readiness.missing, [
    "cua_driver_not_running",
  ]);
  assert.equal(stopped.instance.readiness.level, "installed");
  assert.match(stopped.instance.readiness.reason, /Request access/);
  assert.deepEqual(stopped.instance.backends, [
    {
      id: "cua-driver",
      mode: "remote_ops",
      version: "0.34.1",
      readiness: stopped.instance.readiness,
    },
  ]);
  assert.deepEqual(stopped.instance.details, {
    grantTo: "CuaDriver.app",
    path: bin,
    version: "0.34.1",
  });
  assert.deepEqual(
    stopped.calls.map((call) => call.args.join(" ")),
    ["--version", "permissions status --json"],
    "never starts the daemon or asks for grants",
  );
  assert.ok(stopped.calls.every((call) => call.env.DO_NOT_TRACK === "1"));
  assert.ok(
    stopped.calls.every(
      (call) => call.env.CUA_DRIVER_RS_TELEMETRY_ENABLED === "false",
    ),
  );

  const partly = await detect(bin, {
    "--version": { stdout: "cua-driver 0.34.1" },
    "permissions status --json": {
      stdout: JSON.stringify({
        accessibility: true,
        screen_recording: false,
        screen_recording_capturable: null,
      }),
    },
  });
  assert.equal(partly.instance.readiness.level, "configured");
  assert.deepEqual(partly.instance.readiness.missing, ["tcc_screen_recording"]);

  const ready = await detect(bin, {
    "--version": { stdout: "cua-driver 0.34.1" },
    "permissions status --json": {
      stdout: JSON.stringify({
        accessibility: true,
        screen_recording: true,
        screen_recording_capturable: false,
        source: { attribution: "driver-daemon" },
      }),
    },
  });
  assert.deepEqual(ready.instance.readiness, {
    ready: true,
    level: "permitted",
  });
});

test("the cua-driver detector reports the Request access run", async () => {
  const unknown = {
    "--version": { stdout: "cua-driver 0.34.0" },
    "permissions status --json": {
      stdout: JSON.stringify({
        daemon_running: true,
        reason:
          "CuaDriver daemon is listening, but its real TCC status is not yet available.",
        status: "unknown",
      }),
    },
  };
  const detect = async (grantRun, results = unknown) => {
    const { context } = detectContext(results);
    const [instance] = await createCuaDriverDetector({
      resolveBinary: () =>
        "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      uid: () => 501,
      grantRun: () => grantRun,
      watching: () => true,
    }).detect(context);
    lastDetails = instance.details;
    return instance.readiness;
  };
  let lastDetails;
  const idle = await detect(undefined);
  assert.equal(idle.level, "configured");
  assert.match(idle.reason, /real TCC status is not yet available/);
  assert.deepEqual(idle.missing, ["tcc_accessibility", "tcc_screen_recording"]);

  const waiting = await detect({ state: "running", startedAt: 1 });
  assert.match(
    waiting.reason,
    /^Waiting for you on the Mac: approve CuaDriver/,
  );
  assert.deepEqual(waiting.missing, [
    "cua_driver_awaiting_approval",
    "tcc_accessibility",
    "tcc_screen_recording",
  ]);
  assert.equal(lastDetails.grantRun, "waiting");
  assert.equal(lastDetails.permissionCheck, "live");

  const failed = await detect({
    state: "finished",
    startedAt: 1,
    code: 1,
    output: "Didn't detect the CuaDriver daemon: timeout",
  });
  assert.match(failed.reason, /^The last permission check did not verify/);
  assert.equal(lastDetails.grantRun, "failed");
  assert.equal(
    lastDetails.grantOutput,
    "Didn't detect the CuaDriver daemon: timeout",
  );
  const timedOut = await detect({
    state: "timed_out",
    startedAt: 1,
    output: "",
  });
  assert.match(timedOut.reason, /^The last permission check did not verify/);
  assert.equal(lastDetails.grantRun, "timed_out");

  const granted = await detect(
    { state: "finished", startedAt: 1, code: 0, output: "" },
    {
      ...unknown,
      "permissions status --json": {
        stdout: JSON.stringify({ accessibility: true, screen_recording: true }),
      },
    },
  );
  assert.deepEqual(granted, { ready: true, level: "permitted" });
  assert.equal(lastDetails.grantRun, "verified");
  assert.equal(lastDetails.permissionCheck, undefined, "ready: no live check");
});

test("permission status is read as cua-driver prints it, else loosely", () => {
  assert.deepEqual(parseCuaDriverPermissions("not json"), { running: false });
  assert.deepEqual(
    parseCuaDriverPermissions(
      JSON.stringify({
        daemon_running: true,
        reason:
          "CuaDriver daemon is listening, but its real TCC status is not yet available.",
        status: "unknown",
      }),
    ),
    {
      running: true,
      unknown: true,
      reason:
        "CuaDriver daemon is listening, but its real TCC status is not yet available.",
    },
  );
  assert.deepEqual(
    parseCuaDriverPermissions(
      JSON.stringify({
        accessibility: true,
        screen_recording: false,
        screen_recording_capturable: false,
        source: { attribution: "driver-daemon" },
      }),
    ),
    { running: true, grants: { accessibility: true, screenRecording: false } },
  );
  assert.deepEqual(
    parseCuaDriverPermissions(
      '{"permissions":{"Accessibility":"granted","screenRecording":"denied"}}',
    ),
    { running: true, grants: { accessibility: true, screenRecording: false } },
  );
});

test("install runs the official installer with telemetry off, then disables telemetry", async () => {
  const runs = [];
  const folder = mkdtempSync(join(tmpdir(), "install-"));
  const result = await installResourceBackend(
    { backend: "cua-driver" },
    {
      platform: "darwin",
      env: { HOME: "/Users/p", PATH: "/usr/bin" },
      makeTempDir: async () => folder,
      resolveBinary: () => "/Users/p/.local/bin/cua-driver",
      missing: async () => ["cua_driver_not_running"],
      run: async (command, args, options) => {
        runs.push({ command, args, options });
        return {
          code: 0,
          stdout: command === "/bin/bash" ? "installed CuaDriver.app" : "",
          stderr: "",
          timedOut: false,
          missing: false,
        };
      },
    },
  );
  assert.deepEqual(result, {
    backend: "cua-driver",
    ok: true,
    output: "installed CuaDriver.app",
    missing: ["cua_driver_not_running"],
  });
  assert.deepEqual(
    runs.map((run) => [run.command, ...run.args]),
    [
      [
        "/usr/bin/curl",
        "-fsSL",
        "--proto",
        "=https",
        "-o",
        join(folder, "install.sh"),
        "https://cua.ai/driver/install.sh",
      ],
      ["/bin/bash", join(folder, "install.sh")],
      ["/Users/p/.local/bin/cua-driver", "telemetry", "disable"],
    ],
  );
  for (const run of runs) {
    assert.equal(run.options.env.CUA_DRIVER_NO_MODIFY_PATH, "1");
    assert.equal(run.options.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, "false");
    assert.equal(run.options.env.DO_NOT_TRACK, "1");
  }
  assert.equal(runs[1].options.timeoutMs, 10 * 60_000);
  assert.equal(
    existsSync(folder),
    false,
    "the downloaded installer is removed",
  );

  assert.equal(
    (
      await installResourceBackend(
        { backend: "cua-driver" },
        { platform: "linux" },
      )
    ).ok,
    false,
  );
  const other = await installResourceBackend(
    { backend: "vnc" },
    { platform: "darwin" },
  );
  assert.deepEqual(
    [other.ok, other.error],
    [false, "Foundry cannot install vnc"],
  );
});

test("a grant waiting for the person is tracked and not started twice", async () => {
  resetCuaDriverGrantRun();
  const runs = [];
  let finish;
  const run = async (command, args) => {
    runs.push([command, ...args]);
    if (args[0] === "permissions")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { code: 0, stdout: "", stderr: "", timedOut: false, missing: false };
  };
  const options = {
    platform: "darwin",
    binary: "/Users/p/.local/bin/cua-driver",
    run,
    now: () => 42,
  };
  await requestCuaDriverAccess(options);
  assert.deepEqual(cuaDriverGrantRun(), { state: "running", startedAt: 42 });
  await requestCuaDriverAccess(options);
  assert.equal(runs.length, 2, "the waiting grant is not started again");
  finish({
    code: 1,
    stdout: "Launching CuaDriver\n\n⚠️  Timed out waiting on: Accessibility.\n",
    stderr: "",
    timedOut: false,
    missing: false,
  });
  for (let i = 0; i < 3; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cuaDriverGrantRun(), {
    state: "finished",
    startedAt: 42,
    code: 1,
    output: "Launching CuaDriver\n⚠️  Timed out waiting on: Accessibility.",
  });
  resetCuaDriverGrantRun();
});

test("requesting access starts CuaDriver and asks for its grants", async () => {
  resetCuaDriverGrantRun();
  const runs = [];
  let done = false;
  const opened = await requestCuaDriverAccess({
    platform: "darwin",
    binary: "/Users/p/.local/bin/cua-driver",
    onDone: () => {
      done = true;
    },
    run: async (command, args) => {
      runs.push([command, ...args]);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        missing: false,
      };
    },
  });
  assert.deepEqual(opened, ["cua-driver"]);
  for (let i = 0; i < 3; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [
    ["/usr/bin/open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"],
    ["/Users/p/.local/bin/cua-driver", "permissions", "grant"],
  ]);
  assert.equal(done, true);
  assert.deepEqual(cuaDriverGrantRun(), {
    state: "finished",
    startedAt: cuaDriverGrantRun().startedAt,
    code: 0,
    output: "",
  });
  await assert.rejects(
    requestCuaDriverAccess({ platform: "linux" }),
    /macOS only/,
  );
});

test("a System Settings pane opens and the grants are rechecked live until confirmed", async () => {
  resetCuaDriverGrantRun();
  stopCuaDriverPermissionWatch();
  const runs = [];
  let granted = false;
  let finishGrant;
  const run = async (command, args) => {
    runs.push([command, ...args].join(" "));
    const ok = (stdout = "") => ({
      code: 0,
      stdout,
      stderr: "",
      timedOut: false,
      missing: false,
    });
    if (args[0] === "permissions" && args[1] === "grant")
      return new Promise((resolve) => {
        finishGrant = () => {
          granted = true;
          resolve(ok());
        };
      });
    if (args[0] === "permissions")
      return ok(
        JSON.stringify(
          granted
            ? { accessibility: true, screen_recording: true }
            : { daemon_running: true, status: "unknown", reason: "not yet" },
        ),
      );
    return ok();
  };
  let changes = 0;
  const options = {
    platform: "darwin",
    binary: "/Users/p/.local/bin/cua-driver",
    run,
    intervalMs: 5,
    onChange: () => {
      changes += 1;
    },
  };
  const opened = await openCuaDriverSettings("accessibility", options);
  assert.deepEqual(opened, ["Accessibility"]);
  assert.equal(
    runs[0],
    "/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  assert.equal(cuaDriverPermissionWatchActive(), true);
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(check());
  };
  // Unknown status: the watch runs the grant itself, once.
  await until(() => cuaDriverGrantRun()?.state === "running");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    runs.filter((line) => line.endsWith("permissions grant")).length,
    1,
    "no second grant while one runs",
  );
  // A second pane extends the same watch.
  await openCuaDriverSettings("screen-recording", options);
  assert.ok(
    runs.includes(
      "/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ),
  );
  finishGrant();
  await until(() => !cuaDriverPermissionWatchActive());
  assert.equal(cuaDriverGrantRun().state, "finished");
  assert.ok(changes >= 3, "each change was reported");
  await assert.rejects(
    openCuaDriverSettings("accessibility", { platform: "linux" }),
    /macOS only/,
  );
  resetCuaDriverGrantRun();
});
