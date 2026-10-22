// A fake `cua-driver mcp`: newline-delimited JSON-RPC MCP over stdio with
// the v0.34.1 tool names. Every tools/call is appended to FAKE_CUA_LOG as a
// JSON line ({event, tool, args, at}); FAKE_CUA_DROP names tools (comma
// separated) left out of tools/list.

import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_CUA_LOG;
const dropped = new Set(
  (process.env.FAKE_CUA_DROP ?? "").split(",").filter(Boolean),
);
const record = (entry) => {
  if (log)
    appendFileSync(
      log,
      `${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
    );
};

// A 2×1 PNG.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DAwMDAAAAJ/wH/kEXsOgAAAABJRU5ErkJggg==";

const tools = [
  "get_window_state",
  "get_desktop_state",
  "list_apps",
  "list_windows",
  "launch_app",
  "bring_to_front",
  "click",
  "double_click",
  "right_click",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "drag",
  "set_value",
  "get_screen_size",
  "end_session",
].filter((name) => !dropped.has(name));

// Captured result shapes (see its _source).
const captured = JSON.parse(
  readFileSync(new URL("./cua-driver-results.json", import.meta.url), "utf8"),
);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: "text", text: value }] });

async function call(name, args) {
  if (name === "get_window_state") {
    // Observed against the installed macOS 0.34.0 driver. In particular,
    // tree_format belongs to later contracts and must not creep into select.
    const allowed = new Set([
      "pid",
      "window_id",
      "include_screenshot",
      "include_accessibility_tree",
      "max_image_dimension",
      "max_elements",
      "max_depth",
      "query",
    ]);
    const unknown = Object.keys(args).find((key) => !allowed.has(key));
    if (unknown)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `get_window_state: unknown argument ${unknown}`,
          },
        ],
        structuredContent: {
          status: "refused",
          refusal: { code: "invalid_arguments" },
        },
      };
  }
  if (name === "drag" && args.delivery_mode !== "foreground")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Background drag is unavailable; nothing was sent",
        },
      ],
      structuredContent: { code: "background_unavailable", effect: "refused" },
    };
  if (name === "list_windows" && args.pid === 42)
    return {
      structuredContent: {
        windows: [
          {
            pid: 42,
            window_id: 7,
            is_on_screen: true,
            on_current_space: true,
            bounds: { x: 0, y: 0, width: 500, height: 300 },
          },
        ],
      },
    };
  if (name === "list_windows" || name === "list_apps") return captured[name];
  if (name === "get_window_state")
    return {
      content: [
        ...(args.include_screenshot
          ? [{ type: "image", data: png, mimeType: "image/png" }]
          : []),
        {
          type: "text",
          text: `window_id=${args.window_id} pid=${args.pid} size=2x1 elements=1`,
        },
      ],
      structuredContent: {
        snapshot_id: "snap1",
        screenshot_width: 4,
        screenshot_height: 2,
        screenshot_scale: 2,
      },
    };
  if (name === "get_desktop_state")
    return { content: [{ type: "image", data: png, mimeType: "image/png" }] };
  if (name === "get_screen_size")
    return { content: [], structuredContent: { width: 1512, height: 982 } };
  if (name === "click" && args.x === 666)
    return {
      content: [{ type: "text", text: "boom: no such window" }],
      isError: true,
    };
  if (name === "click" && args.x === 777)
    return {
      content: [
        {
          type: "text",
          text: "screenshot_context_missing: take a screenshot first",
        },
      ],
      isError: true,
    };
  if (name === "type_text" && /^slow\d+$/.test(args.text))
    await new Promise((resolve) =>
      setTimeout(resolve, Number(args.text.slice(4))),
    );
  return text(`ok ${name}`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-cua-driver", version: "0.34.1" },
      },
    });
  if (message.method === "notifications/initialized")
    return record({ event: "initialized" });
  if (message.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
      },
    });
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    record({ event: "start", tool: name, args });
    const result = await call(name, args);
    record({ event: "end", tool: name });
    return send({ jsonrpc: "2.0", id: message.id, result });
  }
  if (message.id !== undefined)
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "unknown method" },
    });
});

process.stdin.on("end", () => {
  record({ event: "exit" });
  process.exit(0);
});
process.on("SIGTERM", () => {
  record({ event: "exit" });
  process.exit(0);
});
