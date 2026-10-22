import assert from "node:assert/strict";
import test from "node:test";
import { WindowScope } from "../dist/resources/providers/macos-window-scope.js";
import { ProviderError } from "../dist/resources/provider.js";
import {
  mapComputerUseAction,
  convertToolResult,
} from "../dist/resources/providers/cua-driver.js";

function fixture() {
  const state = {
    identity: "launch-A",
    now: 1000,
    window: {
      pid: 42,
      window_id: 7,
      is_on_screen: true,
      on_current_space: true,
      bounds: { x: -800, y: 40, width: 500, height: 300 },
    },
    calls: [],
  };
  const scope = new WindowScope(
    async () => {
      if (state.identityError) throw state.identityError;
      return state.identity;
    },
    async (tool, args) => {
      state.calls.push({ tool, args });
      return tool === "list_windows"
        ? { structuredContent: { windows: state.window ? [state.window] : [] } }
        : { structuredContent: { snapshot_id: "snapA" } };
    },
    () => state.now,
  );
  const signal = new AbortController().signal;
  const select = () => scope.select({ pid: 42, window_id: 7 }, signal);
  const validate = (action) => scope.validate(scope.prepare(action), signal);
  const capture = () => {
    const result = {
      content: [{ type: "image", data: "eA==" }],
      structuredContent: { snapshot_id: "snapA" },
    };
    scope.observe({ op: "screenshot" }, result);
    return result.structuredContent.foundry_frame_id;
  };
  return { state, scope, signal, select, validate, capture };
}

test("selection inherits exact target, rejects cross-window and desktop escape", async () => {
  const f = fixture();
  await f.select();
  assert.deepEqual(
    f.scope.prepare({ op: "type_text", args: { text: "test" } }),
    {
      op: "type_text",
      args: { text: "test", pid: 42, window_id: 7 },
    },
  );
  for (const args of [{ pid: 99 }, { window_id: 8 }, { scope: "desktop" }])
    assert.throws(() => f.scope.prepare({ op: "screenshot", args }), {
      code: "target_mismatch",
    });
  await f.validate({ op: "click", args: { element_token: "snapA:1" } });
  await assert.rejects(
    f.validate({ op: "click", args: { element_token: "other:1" } }),
    { code: "stale_element_token" },
  );
  assert.ok(
    f.state.calls.every(({ tool }) =>
      ["list_windows", "get_window_state"].includes(tool),
    ),
  );
});

test("PID reuse and closed windows invalidate selection until explicit reselection", async () => {
  const f = fixture();
  await f.select();
  f.state.identity = "launch-B";
  await assert.rejects(f.validate({ op: "key", args: { key: "return" } }), {
    code: "target_changed",
  });
  f.state.identity = "launch-A";
  await assert.rejects(f.validate({ op: "screenshot" }), {
    code: "target_changed",
  });
  await f.select();
  f.state.window = undefined;
  await assert.rejects(f.validate({ op: "screenshot" }), {
    code: "target_closed",
  });
  await assert.rejects(f.validate({ op: "key", args: { key: "return" } }), {
    code: "target_changed",
  });
});

test("failed replacement clears prior selection and unscoped input cannot use desktop", async () => {
  const f = fixture();
  await f.select();
  f.state.identity = undefined;
  await assert.rejects(f.select(), { code: "target_unavailable" });
  assert.throws(
    () => mapComputerUseAction(f.scope.prepare({ op: "screenshot" })),
    { code: "target_required" },
  );
  assert.throws(
    () => mapComputerUseAction({ op: "key", args: { key: "return" } }),
    { code: "target_required" },
  );
});

test("minimized/other-Space targets refuse without activation", async () => {
  const f = fixture();
  await f.select();
  f.state.window.is_on_screen = false;
  await assert.rejects(
    f.validate({ op: "click", args: { element_token: "snapA:1" } }),
    { code: "background_unavailable" },
  );
  f.state.window.is_on_screen = true;
  f.state.window.on_current_space = false;
  await assert.rejects(f.validate({ op: "screenshot" }), {
    code: "background_unavailable",
  });
  assert.ok(f.state.calls.every(({ tool }) => tool !== "bring_to_front"));
});

test("pixel frame is exact, single-use after input, invalid on geometry changes", async () => {
  const f = fixture();
  await f.select();
  const click = (frame_id) => ({
    op: "click",
    args: { x: 10, y: 20, frame_id },
  });
  await assert.rejects(f.validate(click()), { code: "stale_frame" });
  const frame = f.capture();
  await f.validate(click(frame));
  await assert.rejects(f.validate(click("older")), { code: "stale_frame" });
  f.scope.observe(click(frame), { isError: true });
  await assert.rejects(f.validate(click(frame)), { code: "stale_frame" });
  const fresh = f.capture();
  f.scope.observe(
    { op: "screenshot" },
    { structuredContent: { snapshot_id: "snapA" } },
  );
  await assert.rejects(f.validate(click(fresh)), { code: "stale_frame" });
  const resized = f.capture();
  f.state.window.bounds.x += 1;
  await assert.rejects(f.validate(click(resized)), { code: "stale_frame" });
  const moved = f.capture();
  await f.validate(click(moved));
  f.state.now += 30_001;
  await assert.rejects(f.validate(click(moved)), { code: "stale_frame" });
  assert.equal(
    mapComputerUseAction(f.scope.prepare(click(moved))).args.frame_id,
    undefined,
  );
});

test("background defaults never force drag foreground; activation is explicit", () => {
  const drag = {
    op: "drag",
    args: { pid: 42, window_id: 7, from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
  };
  assert.equal(mapComputerUseAction(drag).args.delivery_mode, "background");
  assert.equal(
    mapComputerUseAction({
      ...drag,
      args: { ...drag.args, delivery_mode: "foreground" },
    }).args.delivery_mode,
    "foreground",
  );
  assert.throws(
    () => mapComputerUseAction({ op: "activate_window", args: { pid: 42 } }),
    { code: "needs_foreground" },
  );
  assert.equal(
    mapComputerUseAction({
      op: "activate_window",
      args: { pid: 42, delivery_mode: "foreground" },
    }).tool,
    "bring_to_front",
  );
});

test("structured backend refusals and unverifiable effects are retained", async () => {
  const encode = async (data, mimeType) => ({ data, mimeType });
  const refused = await convertToolResult(
    "drag",
    {
      isError: true,
      content: [{ type: "text", text: "Nothing was sent" }],
      structuredContent: {
        code: "background_unavailable",
        effect: "refused",
        escalation: { recommended: "foreground" },
      },
    },
    encode,
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "background_unavailable");
  assert.match(refused.error, /"effect":"refused"/);
  const legacyRefusal = await convertToolResult(
    "select_window",
    {
      isError: true,
      structuredContent: {
        status: "refused",
        refusal: { code: "invalid_arguments", message: "unknown argument" },
      },
    },
    encode,
  );
  assert.equal(legacyRefusal.errorCode, "invalid_arguments");
  const unverified = await convertToolResult(
    "click",
    {
      structuredContent: { effect: "unverifiable", verified: false },
    },
    encode,
  );
  assert.equal(unverified.ok, true); // Transport success, not verified UI effect.
  assert.match(unverified.text, /"verified":false/);
});

test("locked-console admission never calls the input backend", async () => {
  let calls = 0;
  const scope = new WindowScope(
    async () => {
      throw new ProviderError("screen_locked", "locked");
    },
    async () => {
      calls++;
      return {};
    },
  );
  await assert.rejects(
    scope.select({ pid: 42, window_id: 7 }, new AbortController().signal),
    { code: "screen_locked" },
  );
  assert.equal(calls, 0);
});

test("a lock after selection invalidates prior observations without backend input", async () => {
  const f = fixture();
  await f.select();
  const frame = f.capture();
  const count = f.state.calls.length;
  f.state.identityError = new ProviderError("screen_locked", "locked");
  await assert.rejects(
    f.validate({ op: "click", args: { x: 10, y: 20, frame_id: frame } }),
    { code: "screen_locked" },
  );
  assert.equal(f.state.calls.length, count);
  f.state.identityError = undefined;
  await assert.rejects(
    f.validate({ op: "click", args: { x: 10, y: 20, frame_id: frame } }),
    { code: "stale_frame" },
  );
  await assert.rejects(
    f.validate({ op: "click", args: { element_token: "snapA:1" } }),
    { code: "stale_element_token" },
  );
});
