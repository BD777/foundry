import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionToolFrames,
  claudeToolResultFrames,
  codexToolCallFrames,
  retainedToolFrames,
  screenshotFilesInText,
  sniffImage,
  toolFramesDirectory,
} from "../dist/tool-frames.js";

function png(width, height, extra = 0) {
  const data = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0,
    0,
  ]);
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "tool-frames-"));
}

test("sniffImage reads type and size, and rejects other bytes", () => {
  assert.deepEqual(sniffImage(png(1280, 720)), {
    mimeType: "image/png",
    extension: "png",
    width: 1280,
    height: 720,
  });
  const info = sniffImage(jpeg(640, 480));
  assert.equal(info.mimeType, "image/jpeg");
  assert.equal(info.width, 640);
  assert.equal(info.height, 480);
  assert.equal(
    sniffImage(Buffer.from("-----BEGIN PRIVATE KEY-----")),
    undefined,
  );
});

test("Claude MCP image results become frames on their call", () => {
  const root = workspace();
  try {
    const message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Took the screenshot" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: png(1280, 720).toString("base64"),
                },
              },
            ],
          },
          { type: "tool_result", tool_use_id: "toolu_2", content: "ok" },
        ],
      },
    };
    const tools = new Map([
      ["toolu_1", "mcp__playwright__browser_take_screenshot"],
      ["toolu_2", "Read"],
    ]);
    const results = claudeToolResultFrames(message, tools, root);
    assert.equal(results.length, 1);
    assert.equal(results[0].callId, "toolu_1");
    const frames = new SessionToolFrames({
      workspacePath: root,
      sessionId: "sess_1",
      inputId: "in_1",
    }).store(results[0]);
    assert.equal(frames.length, 1);
    const [frame] = frames;
    assert.equal(frame.source, "playwright-mcp");
    assert.equal(frame.callId, "toolu_1");
    assert.equal(frame.inputId, "in_1");
    assert.equal(frame.width, 1280);
    assert.equal(frame.height, 720);
    assert.equal(frame.mimeType, "image/png");
    assert.ok(frame.path.startsWith(toolFramesDirectory(root, "sess_1")));
    assert.ok(frame.path.includes("/.foundry/attachments/frames/"));
    assert.deepEqual(readFileSync(frame.path), png(1280, 720));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computer_use results are labelled as such", () => {
  const results = claudeToolResultFrames(
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            content: [
              {
                type: "image",
                source: { type: "base64", data: jpeg(8, 8).toString("base64") },
              },
            ],
          },
        ],
      },
    },
    new Map([["toolu_9", "mcp__foundry__operate_resource"]]),
    "/",
  );
  assert.equal(results[0].candidates[0].source, "computer-use");
});

test("browser CLI screenshot files are found in command output", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, ".playwright-cli"));
    writeFileSync(join(root, ".playwright-cli", "page.png"), png(800, 600));
    const absolute = join(root, "shot.png");
    writeFileSync(absolute, png(320, 200));
    const found = screenshotFilesInText(
      `\x1b[32m✓\x1b[0m Screenshot saved to ${absolute}\n- [Screenshot of viewport](.playwright-cli/page.png)\n`,
      root,
      "Bash",
    );
    assert.deepEqual(
      found.map((item) => [item.file, item.source]),
      [
        [absolute, "agent-browser"],
        [join(root, ".playwright-cli", "page.png"), "playwright-cli"],
      ],
    );
    // A non-image path that a command prints is not a frame.
    assert.deepEqual(
      screenshotFilesInText("Screenshot saved to /etc/passwd", root, "Bash"),
      [],
    );
    const frames = new SessionToolFrames({
      workspacePath: root,
      sessionId: "sess_2",
    }).store({ callId: "c1", tool: "Bash", candidates: found });
    assert.equal(frames.length, 2);
    assert.equal(frames[1].width, 800);
    // The tool's own file stays where it was; the frame is a copy.
    assert.ok(existsSync(absolute));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that is not an image is never copied", () => {
  const root = workspace();
  try {
    const secret = join(root, "secret.png");
    writeFileSync(secret, "proxy-password=hunter2");
    const frames = new SessionToolFrames({
      workspacePath: root,
      sessionId: "sess_3",
    }).store({
      callId: "c1",
      tool: "Bash",
      candidates: [{ file: secret, source: "agent-browser" }],
    });
    assert.deepEqual(frames, []);
    assert.equal(existsSync(toolFramesDirectory(root, "sess_3")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex MCP results and command output give frames", () => {
  const image = png(100, 50).toString("base64");
  const mcp = codexToolCallFrames(
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "mcp_tool_call",
        server: "playwright",
        tool: "browser_take_screenshot",
        status: "completed",
        result: {
          content: [{ type: "image", data: image, mimeType: "image/png" }],
        },
      },
    },
    "/",
  );
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].callId, "item_1");
  assert.equal(mcp[0].tool, "playwright.browser_take_screenshot");
  assert.equal(mcp[0].candidates[0].source, "playwright-mcp");
  const shell = codexToolCallFrames(
    {
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        aggregated_output: "Screenshot saved to /tmp/x.png",
      },
    },
    "/",
  );
  assert.equal(shell[0].candidates[0].source, "agent-browser");
  // Started items carry no result yet.
  assert.deepEqual(
    codexToolCallFrames(
      { type: "item.started", item: { id: "i", type: "mcp_tool_call" } },
      "/",
    ),
    [],
  );
});

test("retention keeps the newest frames within both limits", () => {
  const frames = Array.from({ length: 6 }, (_, index) => ({
    id: index,
    bytes: 10,
  }));
  const byCount = retainedToolFrames(frames, { count: 4, bytes: 1000 });
  assert.deepEqual(
    byCount.kept.map((frame) => frame.id),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    byCount.dropped.map((frame) => frame.id),
    [0, 1],
  );
  const byBytes = retainedToolFrames(frames, { count: 100, bytes: 35 });
  assert.deepEqual(
    byBytes.kept.map((frame) => frame.id),
    [3, 4, 5],
  );
  // Once a frame does not fit, every older one goes too.
  const mixed = retainedToolFrames(
    [
      { id: "a", bytes: 1 },
      { id: "big", bytes: 50 },
      { id: "c", bytes: 1 },
    ],
    { count: 10, bytes: 30 },
  );
  assert.deepEqual(
    mixed.kept.map((frame) => frame.id),
    ["c"],
  );
});

test("the device keeps at most the limit of frame files per session", () => {
  const root = workspace();
  try {
    let now = 1_700_000_000_000;
    const store = new SessionToolFrames({
      workspacePath: root,
      sessionId: "sess_cap",
      now: () => (now += 1000),
    });
    const image = png(4, 4);
    for (let index = 0; index < 205; index += 1)
      store.store({
        callId: `c${index}`,
        tool: "mcp__playwright__browser_take_screenshot",
        candidates: [{ data: image, source: "playwright-mcp" }],
      });
    const names = readdirSync(toolFramesDirectory(root, "sess_cap")).sort();
    assert.equal(names.length, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
