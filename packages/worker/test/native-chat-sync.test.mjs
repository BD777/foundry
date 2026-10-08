import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "native-sync-"));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const { initWorkspace } = await import("../dist/workspaces.js");
const { syncNativeChats } = await import("../dist/workspace-ops.js");

function session(workspace, id, text) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "p");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ sessionId: id, cwd: workspace, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: text } })}\n`,
  );
  return path;
}

test(
  "native chat sync sends summaries once, then only chats that changed",
  { timeout: 60000 },
  async () => {
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    initWorkspace(workspace);
    const paths = ["a", "b", "c"].map((id) =>
      session(
        workspace,
        `11111111-1111-1111-1111-11111111111${id === "a" ? 1 : id === "b" ? 2 : 3}`,
        `hello ${id}`,
      ),
    );
    const posts = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        posts.push(JSON.parse(body));
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal(await syncNativeChats(url, workspace), 3);
      // One summary batch with every chat, then each chat in full.
      assert.equal(posts.length, 4);
      assert.equal(posts[0].chats.length, 3);
      assert.ok(posts[0].chats.every((chat) => chat.transcript === undefined));
      assert.ok(posts.slice(1).every((post) => post.chats.length === 1));

      posts.length = 0;
      assert.equal(await syncNativeChats(url, workspace), 0);
      assert.equal(posts.length, 0, "nothing changed, nothing sent");

      appendFileSync(
        paths[1],
        `${JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:00Z", message: { role: "assistant", content: "reply" } })}\n`,
      );
      assert.equal(await syncNativeChats(url, workspace), 1);
      assert.equal(posts.length, 1, "only the changed chat, in full");
    } finally {
      server.close();
    }
  },
);
