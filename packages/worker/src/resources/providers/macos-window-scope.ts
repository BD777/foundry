// A lease-local window selection. No OS input is generated here: the driver
// remains responsible for AX/event delivery and live element validation.
import { randomUUID } from "node:crypto";
import type { ResourceAction } from "@bd777/foundry-protocol";
import { execBounded } from "../exec.js";
import { ProviderError } from "../provider.js";
import type { McpToolResult } from "./mcp-stdio.js";

const windowActions = new Set([
  "screenshot",
  "get_ui_tree",
  "find_elements",
  "activate_window",
  "click",
  "double_click",
  "right_click",
  "type_text",
  "key",
  "hotkey",
  "scroll",
  "drag",
  "set_value",
]);
const observations = new Set(["screenshot", "get_ui_tree", "find_elements"]);

/** AppKit metadata only: no System Events, AX prompts, activation or clipboard. */
export async function readMacAppIdentity(
  pid: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const script = `ObjC.import('AppKit');
ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]);
function run(args) {
  const session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());
  if (session && session.CGSSessionScreenIsLocked === true) return 'screen_locked';
  if (!session || session.kCGSSessionOnConsoleKey !== true) return 'console_unavailable';
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (app.isNil() || app.launchDate.isNil()) return '';
  return JSON.stringify({launch:app.launchDate.timeIntervalSince1970, bundle:ObjC.unwrap(app.bundleIdentifier)});
}`;
  const result = await execBounded(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, String(pid)],
    {
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      signal,
    },
  );
  if (result.code !== 0)
    throw new ProviderError(
      "target_unavailable",
      `Cannot read application launch identity: ${result.stderr.trim().slice(0, 300) || "metadata query failed"}`,
    );
  const value = result.stdout.trim();
  if (value === "screen_locked")
    throw new ProviderError(
      "screen_locked",
      "The Mac is locked; unlock it before selecting or operating a window. Nothing was sent",
    );
  if (value === "console_unavailable")
    throw new ProviderError(
      "console_unavailable",
      "No active console session could be verified; no input was sent",
    );
  return value || undefined;
}

type Call = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<McpToolResult>;
interface Selection {
  pid: number;
  window_id: number;
  identity: string;
  snapshot?: string;
  frame?: { id: string; bounds: string; capturedAt: number };
  bounds: string;
  invalid?: string;
}

export class WindowScope {
  private selected?: Selection;
  constructor(
    private readonly identity: typeof readMacAppIdentity,
    private readonly call: Call,
    private readonly now: () => number = Date.now,
  ) {}

  prepare(action: ResourceAction): ResourceAction {
    if (!this.selected || !windowActions.has(action.op)) return action;
    const args = action.args ?? {};
    if (args.scope === "desktop")
      throw new ProviderError(
        "target_mismatch",
        "A selected-window lease cannot fall back to desktop capture; use a separate lease",
      );
    for (const name of ["pid", "window_id"] as const)
      if (args[name] !== undefined && args[name] !== this.selected[name])
        throw new ProviderError(
          "target_mismatch",
          "This lease is bound to another window; use select_window to change it",
        );
    return {
      ...action,
      args: {
        ...args,
        pid: this.selected.pid,
        window_id: this.selected.window_id,
      },
    };
  }

  private async window(
    pid: number,
    window_id: number,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.call(
      "list_windows",
      { pid, on_screen_only: false },
      signal,
    );
    const windows = result.structuredContent?.windows;
    if (result.isError || !Array.isArray(windows))
      throw new ProviderError(
        "backend_unsupported",
        "The driver cannot validate an exact window (list_windows structured records required)",
      );
    const found = windows.find(
      (item) => item && item.pid === pid && item.window_id === window_id,
    );
    if (!found)
      throw new ProviderError(
        "target_closed",
        "The selected window no longer exists under this process; select a live window",
      );
    if (found.is_on_screen !== true || found.on_current_space === false)
      throw new ProviderError(
        "background_unavailable",
        "The selected window is minimized, hidden or on another Space; no activation or input was sent",
      );
    const b = found.bounds;
    if (
      !b ||
      !["x", "y", "width", "height"].every((key) => Number.isFinite(b[key])) ||
      b.width <= 0 ||
      b.height <= 0
    )
      throw new ProviderError(
        "backend_unsupported",
        "The driver did not provide valid window bounds",
      );
    return JSON.stringify([b.x, b.y, b.width, b.height]);
  }

  async select(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    // A failed replacement cannot leave the old target silently selected.
    this.selected = undefined;
    const pid = args.pid as number,
      window_id = args.window_id as number;
    const identity = await this.identity(pid, signal);
    if (!identity)
      throw new ProviderError(
        "target_unavailable",
        "Cannot establish the target application's launch identity",
      );
    const bounds = await this.window(pid, window_id, signal);
    const result = await this.call(
      "get_window_state",
      {
        pid,
        window_id,
        include_screenshot: false,
        include_accessibility_tree: true,
        max_elements: 250,
      },
      signal,
    );
    if (result.isError) return result;
    if ((await this.identity(pid, signal)) !== identity)
      throw new ProviderError(
        "target_changed",
        "The process changed while selecting its window",
      );
    this.selected = { pid, window_id, identity, bounds };
    this.observe({ op: "get_ui_tree" }, result);
    result.structuredContent = {
      ...result.structuredContent,
      foundry_window_scope: {
        pid,
        window_id,
        default_delivery: "background",
        input_guarantee:
          "best_effort; observe effect and user focus separately",
        coordinates:
          "take screenshot, then repeat its frameId as frame_id for pixel input",
        lifetime:
          "this provider session; reselect after idle close or lease reset",
      },
    };
    return result;
  }

  async validate(action: ResourceAction, signal: AbortSignal): Promise<void> {
    const selected = this.selected;
    if (!selected || !windowActions.has(action.op)) return;
    if (selected.invalid)
      throw new ProviderError("target_changed", selected.invalid);
    const readIdentity = async (): Promise<string | undefined> => {
      try {
        return await this.identity(selected.pid, signal);
      } catch (error) {
        // A lock, console change or failed identity check breaks the
        // observation chain even when the same app is available later.
        selected.frame = undefined;
        selected.snapshot = undefined;
        throw error;
      }
    };
    const identity = await readIdentity();
    if (!identity || identity !== selected.identity) {
      selected.invalid =
        "The selected application exited or restarted; select_window again";
      throw new ProviderError("target_changed", selected.invalid);
    }
    try {
      selected.bounds = await this.window(
        selected.pid,
        selected.window_id,
        signal,
      );
    } catch (error) {
      selected.frame = undefined;
      if (error instanceof ProviderError && error.code === "target_closed")
        selected.invalid = error.message;
      throw error;
    }
    if ((await readIdentity()) !== selected.identity) {
      selected.invalid =
        "The selected application changed during window validation";
      throw new ProviderError("target_changed", selected.invalid);
    }
    if (observations.has(action.op)) return;
    const args = action.args ?? {};
    if (
      typeof args.element_token === "string" &&
      (!selected.snapshot ||
        !args.element_token.startsWith(`${selected.snapshot}:`))
    )
      throw new ProviderError(
        "stale_element_token",
        "Read the selected window's UI tree again and use its element_token",
      );
    const pixels = "x" in args || action.op === "drag";
    if (
      pixels &&
      (!selected.frame ||
        args.frame_id !== selected.frame.id ||
        selected.frame.bounds !== selected.bounds ||
        this.now() - selected.frame.capturedAt > 30_000)
    )
      throw new ProviderError(
        "stale_frame",
        "Take a fresh screenshot of the selected window and pass its frameId as frame_id",
      );
  }

  begin(action: ResourceAction): void {
    if (this.selected && windowActions.has(action.op))
      this.selected.frame = undefined;
  }

  observe(action: ResourceAction, result: McpToolResult): void {
    const selected = this.selected;
    if (!selected || !windowActions.has(action.op)) return;
    if (!observations.has(action.op)) {
      // Even an unsuccessful input can partially change the target.
      selected.frame = undefined;
      return;
    }
    // A new observation with a missing/failed capture must not leave the
    // previous image usable by accident.
    selected.frame = undefined;
    if (result.isError) {
      return;
    }
    const snapshot = result.structuredContent?.snapshot_id;
    if (typeof snapshot === "string" || typeof snapshot === "number")
      selected.snapshot = String(snapshot);
    if (result.content?.some((block) => block.type === "image")) {
      const id = `frame_${randomUUID()}`;
      selected.frame = { id, bounds: selected.bounds, capturedAt: this.now() };
      result.structuredContent = {
        ...result.structuredContent,
        foundry_frame_id: id,
      };
    }
  }
}
