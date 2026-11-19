import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "native-scan-cost-"));
process.env.HOME = root;
process.env.CODEX_HOME = join(root, "codex");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const nativeChat = await import("../dist/session/chat/native-chat.js");
const { foundryStatePath } = await import("../dist/platform/state-root.js");

let next = 0;
function claudeLog(workspace, lines = 1) {
  next += 1;
  const id = `44444444-4444-4444-4444-${String(next).padStart(12, "0")}`;
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", `p${next}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const records = [];
  for (let i = 0; i < lines; i += 1)
    records.push(
      JSON.stringify({
        sessionId: id,
        cwd: workspace,
        type: i % 2 ? "assistant" : "user",
        timestamp: "2026-10-01T00:00:00Z",
        message: {
          role: i % 2 ? "assistant" : "user",
          content: `synthetic ${i}`,
        },
      }),
    );
  writeFileSync(path, `${records.join("\n")}\n`);
  return { id, path, chatId: `native_claude_${id}` };
}

function workspaceFolder(name) {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  return { id: `ws_${name}`, name, localPath: folder };
}

test("a chat the server never keeps is answered from its log's header, without its transcript", async () => {
  const workspace = workspaceFolder("summary-only");
  const kept = claudeLog(workspace.localPath);
  const owned = claudeLog(workspace.localPath);
  nativeChat.invalidateNativeChatListings();
  const snapshot = await nativeChat.nativeChatSnapshotForWorkspace(
    workspace,
    [],
    60,
    new Set(),
    undefined,
    new Set([owned.chatId]),
  );
  assert.equal(snapshot.stats.summarizedFiles, 1);
  assert.equal(snapshot.stats.parsedFiles, 1);
  const byId = new Map(snapshot.chats.map((chat) => [chat.id, chat]));
  assert.ok(byId.get(kept.chatId)?.transcript?.length);
  const summary = byId.get(owned.chatId);
  assert.ok(summary, "the summary-only chat is still listed");
  assert.equal(summary.transcript, undefined);
  assert.equal(summary.nativeSessionId, owned.id);
  assert.equal(summary.archived, false);
});

test("an unchanged chat keeps its fingerprint across rounds; a change gives a new one", async () => {
  const workspace = workspaceFolder("fingerprints");
  const log = claudeLog(workspace.localPath, 2);
  nativeChat.invalidateNativeChatListings();
  const scan = () =>
    nativeChat.nativeChatSnapshotForWorkspace(workspace, [], 60, new Set());
  const first = (await scan()).fingerprints.get(log.chatId);
  const second = await scan();
  assert.equal(second.fingerprints.get(log.chatId), first);
  assert.equal(second.stats.parsedFiles, 0);
  appendFileSync(
    log.path,
    `${JSON.stringify({ sessionId: log.id, cwd: workspace.localPath, type: "assistant", timestamp: "2026-10-02T00:00:00Z", message: { role: "assistant", content: "more" } })}\n`,
  );
  assert.notEqual((await scan()).fingerprints.get(log.chatId), first);
});

test("a restarted scan takes complete log headers from the state root instead of the logs", async () => {
  const workspace = workspaceFolder("headers");
  // 200 lines: the header is complete (settled).
  const log = claudeLog(workspace.localPath, 200);
  nativeChat.invalidateNativeChatListings();
  const before = await nativeChat.nativeChatSnapshotForWorkspace(workspace, []);
  assert.ok(before.chats.some((chat) => chat.id === log.chatId));
  const kept = JSON.parse(
    readFileSync(foundryStatePath("native-log-headers.json"), "utf8"),
  );
  assert.equal(kept.version, 1);
  assert.ok(
    kept.headers.some(
      ([path, folder, id]) =>
        path === log.path && folder === workspace.localPath && id === log.id,
    ),
  );
  // A fresh module instance stands for a restarted worker. The kept header
  // names the folder, so the log's start is not read again.
  const restarted = await import(
    `../dist/session/chat/native-chat.js?restart=${Date.now()}`
  );
  const other = workspaceFolder("headers-moved");
  const text = readFileSync(log.path, "utf8");
  writeFileSync(
    log.path,
    text.replaceAll(
      JSON.stringify(workspace.localPath),
      JSON.stringify(other.localPath).padEnd(
        JSON.stringify(workspace.localPath).length,
      ),
    ),
  );
  const after = await restarted.nativeChatSnapshotForWorkspace(
    workspace,
    [],
    60,
    new Set(),
    undefined,
    new Set([log.chatId]),
  );
  assert.ok(
    after.chats.some((chat) => chat.id === log.chatId),
    "the kept header still places the log in its workspace",
  );
  assert.equal(after.stats.summarizedFiles, 1);
  assert.ok(existsSync(foundryStatePath("native-log-headers.json")));
});

test("workspaces scanned side by side share each log's header read and see the same chats", async () => {
  const one = workspaceFolder("parallel-one");
  const two = workspaceFolder("parallel-two");
  const a = claudeLog(one.localPath, 3);
  const b = claudeLog(two.localPath, 3);
  const fresh = await import(
    `../dist/session/chat/native-chat.js?parallel=${Date.now()}`
  );
  const [first, second] = await Promise.all([
    fresh.nativeChatSnapshotForWorkspace(one, []),
    fresh.nativeChatSnapshotForWorkspace(two, []),
  ]);
  assert.ok(first.chats.some((chat) => chat.id === a.chatId));
  assert.ok(!first.chats.some((chat) => chat.id === b.chatId));
  assert.ok(second.chats.some((chat) => chat.id === b.chatId));
  assert.ok(!second.chats.some((chat) => chat.id === a.chatId));
});
