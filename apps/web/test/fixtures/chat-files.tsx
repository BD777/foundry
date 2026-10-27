/** Real file panel/hooks and Markdown references; synthetic read-only transport. */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import { Button } from "../../src/components/ui/button";
import { MarkdownContent } from "../../src/components/conversation/markdown-content";
import { ChatDetailPanel } from "../../src/features/chat/chat-detail-panel";
import { useChatContextDetail } from "../../src/features/chat/use-chat-context-detail";
import type {
  ChatContextSelection,
  ChatSessionFileItem,
} from "../../src/features/chat/chat-types";
import "../../src/styles.css";
import "./chat-files.css";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
const path =
  "/synthetic/.foundry/attachments/20261027/autorun-business-running-73695c75c20c.json";
const fileName = path.split("/").pop()!;
const complete = new TextEncoder().encode(
  JSON.stringify(
    {
      title: "Synthetic complete file",
      entries: Array.from({ length: 16000 }, (_, i) => ({
        index: i,
        text: "第😀行",
      })),
    },
    null,
    2,
  ),
);
const original = window.fetch.bind(window);
const counts = new Map<string, number>();
let restored = false;
window.fetch = async (url, init) => {
  const target = new URL(String(url), location.href);
  const session = target.pathname.includes("/api/agent-sessions/");
  const download = target.pathname.endsWith("/download");
  const preview = target.pathname.endsWith("/read");
  if (target.pathname.endsWith("/tree"))
    return Response.json([
      {
        id: "file",
        path,
        name: fileName,
        isDirectory: false,
        size: complete.length,
      },
    ]);
  if (!session && !target.pathname.startsWith("/api/workspace-files/"))
    return original(url, init);
  const key = `${session ? "session" : "workspace"}-${download ? "download" : "preview"}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, params.has("hold") ? 4000 : 200);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
  const attempt = (counts.get(key) || 0) + 1;
  counts.set(key, attempt);
  document.documentElement.dataset.fileRequests = JSON.stringify(
    Object.fromEntries(counts),
  );
  if (params.get("scenario") === "offline" && !restored)
    return new Response("offline", { status: 409 });
  if (params.get("scenario") === "missing")
    return new Response("missing", { status: 404 });
  const failures = params.get("scenario") === "recover" ? 1 : 2;
  if (!restored && attempt <= failures)
    return new Response("slow", { status: 504 });
  if (download)
    return new Response(complete, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(complete.length),
      },
    });
  const content = new TextDecoder().decode(
    complete.subarray(0, session ? 256 * 1024 : 128 * 1024),
  );
  if (preview)
    return Response.json(
      session
        ? {
            sessionId: "synthetic-file-session",
            path,
            origin: "reference",
            insideWorkspace: true,
            kind: "text",
            bytes: complete.length,
            content,
            truncated: true,
            changedSinceRecorded: false,
          }
        : { workspaceId: "synthetic", path, content, truncated: true },
    );
  return original(url, init);
};
const selection: ChatSessionFileItem = {
  kind: "session-file",
  id: path,
  label: fileName,
  path,
  workspacePath: path.slice("/synthetic/".length),
  origin: "reference",
  op: "referenced",
  inGitRepo: false,
  turnIds: [],
  sessionId: "synthetic-file-session",
  workspaceId: "synthetic",
};
const source: ChatContextSelection = {
  kind: "source",
  id: "source",
  label: "Attachments",
  target: "/synthetic/.foundry/attachments",
  workspaceId: "synthetic",
};
function Fixture() {
  const detail = useChatContextDetail("fixture");
  const [ready, setReady] = useState(false);
  useEffect(() => detail.setSelection(selection), []);
  return (
    <main className="fdy-chat-files-fixture">
      <header>
        <h1>DEV-051 · files and inline references</h1>
        <div className="fdy-chat-files-fixture-actions">
          <Button onClick={() => detail.setSelection({ ...selection })}>
            Session file
          </Button>
          <Button onClick={() => detail.setSelection(source)}>
            Workspace folder
          </Button>
          <Button
            disabled={ready}
            onClick={() => {
              restored = true;
              setReady(true);
            }}
          >
            Restore device
          </Button>
        </div>
      </header>
      <div className="fdy-chat-files-fixture-layout">
        <article className="fdy-markdown">
          <MarkdownContent
            fileReferences={[
              { text: path, path, kind: "file" },
              { text: path.slice("/synthetic/".length), path, kind: "file" },
            ]}
            onOpenFileReference={() => detail.setSelection({ ...selection })}
          >{`文件副本保存在\n\n\`${path.slice("/synthetic/".length)}\`\n\n，已核对内容与原始文件一致。\n\n[打开或下载原始 JSON](${path})`}</MarkdownContent>
        </article>
        {detail.selection ? (
          <ChatDetailPanel
            {...detail}
            selection={detail.selection}
            onClose={detail.close}
            onRetry={detail.retry}
          />
        ) : null}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
