import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createCuaDriverProvider } from "./dev028-provider.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const driver = process.env.DEV028_DRIVER;
const consoleState = JSON.parse(
  execFileSync(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      "ObjC.import('AppKit');ObjC.bindFunction('CGSessionCopyCurrentDictionary',['id',[]]);const s=ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());JSON.stringify({locked:!!(s&&s.CGSSessionScreenIsLocked),onConsole:!!(s&&s.kCGSSessionOnConsoleKey)})",
    ],
    { encoding: "utf8" },
  ),
);
if (consoleState.locked || !consoleState.onConsole)
  throw new Error("Console is locked or unavailable; no App was launched");
const permissions = JSON.parse(
  execFileSync(driver, ["permissions", "status", "--json"], {
    encoding: "utf8",
  }),
);
if (
  permissions.daemon_running === false ||
  permissions.accessibility !== true ||
  permissions.screen_recording !== true
)
  throw new Error(
    "Driver not already running; no automatic start or permission request",
  );
await rm("probe-state.json", { force: true });
await rm("probe-state.json.command", { force: true });
await rm("monitor-state.json", { force: true });
const monitor = spawn(
  "./Dev028Probe.app/Contents/MacOS/probe",
  ["--monitor", `${process.cwd()}/monitor-state.json`],
  { stdio: "ignore" },
);
const monitorState = () =>
  readFile("monitor-state.json", "utf8").then(JSON.parse);
let monitoring;
for (let i = 0; i < 500; i++) {
  try {
    monitoring = await monitorState();
    break;
  } catch {
    await pause(20);
  }
}
if (!monitoring) {
  monitor.kill("SIGTERM");
  throw new Error("Read-only monitor did not start; no App launched");
}
if (
  [
    "pointer_changed",
    "frontmost_changed",
    "keyboard_focus_changed",
    "clipboard_changed",
  ].some((key) => monitoring[key] === true)
) {
  monitor.kill("SIGTERM");
  throw new Error(
    "Global state changed during pre-launch sampling; no App launched",
  );
}
const child = spawn(
  "/usr/bin/open",
  [
    "-g",
    "-n",
    `${process.cwd()}/Dev028Probe.app`,
    "--args",
    `${process.cwd()}/probe-state.json`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (x) => (stderr += x.toString()));
const state = () => readFile("probe-state.json", "utf8").then(JSON.parse);
const checkpoint = async (label) => {
  await writeFile("probe-state.json.command", `reset-${label}`);
  await pause(80);
};
const ensureQuiet = (value) => {
  if (
    [
      "pointer_changed",
      "frontmost_changed",
      "keyboard_focus_changed",
      "clipboard_changed",
    ].some((key) => value[key] === true)
  )
    throw new Error(
      "Observed global state change; stopping further input (may include independent user activity)",
    );
};
let session;
const proof = {
  permissions,
  results: [],
  limitations: [
    "Synthetic AppKit controls only",
    "10ms sampling cannot prove zero transient interference",
    "No simultaneous human typing test",
  ],
};
const parse = (r) => {
  const t = r.text ?? "";
  const i = t.lastIndexOf("\n{");
  try {
    return JSON.parse(i >= 0 ? t.slice(i + 1) : t);
  } catch {
    return {};
  }
};
try {
  let initial;
  for (let i = 0; i < 100; i++) {
    try {
      initial = await state();
      break;
    } catch {
      await pause(50);
    }
  }
  if (!initial) throw new Error(`Synthetic App did not start: ${stderr}`);
  proof.initial = initial;
  ensureQuiet(initial);
  const provider = createCuaDriverProvider({
    command: () => ({ command: driver, args: ["mcp"] }),
  });
  session = await provider.open("synthetic", {
    id: "dev028-test",
    generation: 1,
  });
  const invoke = async (op, args = {}) => {
    ensureQuiet(await monitorState());
    const r = await session.invoke({ op, args }, AbortSignal.timeout(30000));
    const item = {
      op,
      ok: r.ok,
      errorCode: r.errorCode,
      error: r.error,
      text: r.text,
      images: r.images?.map(({ data, ...rest }) => rest),
    };
    proof.results.push(item);
    ensureQuiet(await monitorState());
    return r;
  };
  await pause(800);
  const selected = await invoke("select_window", {
    pid: initial.pid,
    window_id: initial.window_id,
  });
  if (!selected.ok) throw new Error("selection failed");
  let data = parse(selected),
    elements = data.elements ?? [];
  if (!elements.length) {
    await pause(1000);
    data = parse(
      await invoke("select_window", {
        pid: initial.pid,
        window_id: initial.window_id,
      }),
    );
    elements = data.elements ?? [];
  }
  proof.elementSummary = elements.map((e) => ({
    role: e.role,
    label: e.label,
    value: e.value,
    element_token: e.element_token,
  }));
  const field = elements.find((e) => e.role === "AXTextField");
  const button = elements.find(
    (e) => e.role === "AXButton" && String(e.label).includes("Increment"),
  );
  const scroll = elements.find((e) => e.role === "AXScrollArea");
  if (!field || !button)
    throw new Error("Synthetic controls were not found in structured AX tree");
  await checkpoint("ax-value");
  await invoke("set_value", {
    element_token: field.element_token,
    value: "DEV028 background value",
  });
  await pause(100);
  proof.valueState = await state();
  ensureQuiet(proof.valueState);
  await checkpoint("ax-type");
  await invoke("type_text", {
    element_token: field.element_token,
    text: " DEV028 typed",
  });
  await pause(100);
  proof.typeState = await state();
  ensureQuiet(proof.typeState);
  await checkpoint("ax-click");
  await invoke("click", { element_token: button.element_token });
  await pause(100);
  proof.clickState = await state();
  ensureQuiet(proof.clickState);
  if (scroll) {
    await checkpoint("ax-scroll");
    await invoke("scroll", {
      element_token: scroll.element_token,
      direction: "down",
      amount: 3,
    });
    await pause(100);
    proof.scrollState = await state();
    ensureQuiet(proof.scrollState);
  }
  const shot = await invoke("screenshot");
  if (shot.images?.[0])
    await writeFile(
      "synthetic-window.jpg",
      Buffer.from(shot.images[0].data, "base64"),
    );
  await checkpoint("background-drag-refusal");
  await invoke("drag", {
    from_x: 20,
    from_y: 20,
    to_x: 60,
    to_y: 60,
    frame_id: shot.images?.[0]?.frameId,
  });
  await pause(100);
  proof.dragState = await state();
  ensureQuiet(proof.dragState);
  const fresh = await invoke("screenshot");
  await writeFile("probe-state.json.command", "resize");
  await pause(100);
  await checkpoint("stale-frame");
  await invoke("click", { x: 20, y: 20, frame_id: fresh.images?.[0]?.frameId });
  await pause(100);
  proof.staleState = await state();
  ensureQuiet(proof.staleState);
  await writeFile("probe-state.json.command", "close");
  await pause(100);
  await checkpoint("hidden-window");
  await invoke("click", { element_token: button.element_token });
  proof.hiddenState = await state();
  ensureQuiet(proof.hiddenState);
} catch (error) {
  proof.failure = String(error);
} finally {
  if (session) {
    await session.reset();
    await session.close();
  }
  await writeFile("probe-state.json.command", "exit");
  await pause(300);
  if (child.exitCode === null) child.kill("SIGTERM");
  if (proof.initial?.pid) {
    try {
      process.kill(proof.initial.pid, 0);
      proof.cleanup = { probeExited: false };
    } catch (e) {
      proof.cleanup = { probeExited: e.code === "ESRCH" };
    }
  }
  if (proof.failure || proof.cleanup?.probeExited === false)
    process.exitCode = 1;
  proof.monitorFinal = await monitorState().catch(() => ({
    unavailable: true,
  }));
  if (monitor.exitCode === null) monitor.kill("SIGTERM");
  await writeFile("proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}
