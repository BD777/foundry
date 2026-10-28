/** Real archive surfaces with synthetic API data; never changes live chats. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type {
  ArchiveBlocker,
  ChatLayout,
  ChatThread,
} from "@bd777/foundry-protocol";
import "../../src/styles.css";
import "./chat-archive-fixture.css";
import "../../src/features/chat/chat-archive.css";
import { i18n } from "../../src/i18n";
import { ChatSurface } from "../../src/features/chat/chat-surface";
import { archiveSurfaceProps } from "./chat-archive-surface-props";
import { ArchivedChatsView } from "../../src/features/chat/archived-chats-view";
import { ChatArchiveBanner } from "../../src/features/chat/chat-archive-banner";
import { archivedChatRows } from "../../src/features/chat/chat-archive-model";
import { useChatArchive } from "../../src/features/chat/use-chat-archive";
import { ToastProvider } from "../../src/components/ui/toast";
import { Button } from "../../src/components/ui/button";
import type { ChatListItem } from "../../src/features/chat/chat-surface-types";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "en");
document.documentElement.dataset.theme = params.get("theme") || "light";
const rows: ChatThread[] = (
  params.get("acceptance")
    ? [
        "Design notes: a modular roadmap",
        "Development",
        "Integration rehearsal with a very long chat title that must stay on one line in the archive confirmation list",
        "Gateway validation: two synthetic accounts",
        "Upstream gateway mode",
      ]
    : ["First archived candidate", "Second archived candidate", "Running chat"]
).map((title, index) => ({
  id: `fixture-${index}`,
  title,
  preview: "Synthetic archive transcript",
  provider: params.get("acceptance") && index === 1 ? "claude" : "codex",
  deviceId: "fixture-device",
  workspaceId: "archive-fixture",
  readonly: false,
  status: params.get("acceptance")
    ? index === 2
      ? "failed"
      : index === 3
        ? "canceled"
        : "completed"
    : index === 2
      ? "running"
      : "completed",
  updatedAt: "2026-10-27T03:00:00Z",
  nativeSessionId: `native-${index}`,
})) as ChatThread[];
const layout: ChatLayout = {
  revision: 1,
  groups: [{ id: "folder", name: "Archive test folder" }],
  positions: rows.map((row, order) => ({
    chatId: row.id,
    groupId: "folder",
    order,
  })),
} as ChatLayout;
let fixtureOperation: "idle" | "pending" | "verified" = "idle";
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  await new Promise((resolve) =>
    setTimeout(resolve, Number(params.get("delay") || 100)),
  );
  if (url.pathname === "/api/chat-layout") {
    if (init?.method === "POST") {
      const next = JSON.parse(String(init.body)).layout as ChatLayout;
      layout.positions = next.positions;
      layout.revision++;
    }
    return json(layout);
  }
  if (url.pathname.endsWith("/cancel")) {
    const row = rows.find((item) => url.pathname.includes(item.id));
    if (row) row.status = "canceled";
    return json(row);
  }
  if (url.pathname.endsWith("/work/operations")) {
    fixtureOperation = "pending";
    return json({
      id: "fixture-operation",
      state: "pending",
      items: [{ id: "fixture-work", revision: 4 }],
    });
  }
  if (
    url.pathname.endsWith("/work") &&
    fixtureOperation === "idle" &&
    params.get("acceptance")
  ) {
    return json({
      items: [
        {
          id: "legacy-parent-agent",
          sessionId: "fixture-1",
          kind: "agent",
          source: "claude",
          management: "observed",
          desiredState: "enabled",
          observation: { status: "unknown" },
          native: { runtime: "claude", controls: { stop: "unknown" } },
        },
        {
          id: "legacy-codex-failed",
          sessionId: "fixture-2",
          kind: "process",
          source: "codex",
          management: "observed",
          desiredState: "enabled",
          observation: { status: "failed" },
          native: { runtime: "codex", controls: { stop: "available" } },
        },
        {
          id: "legacy-codex-canceled",
          sessionId: "fixture-3",
          kind: "process",
          source: "codex",
          management: "observed",
          desiredState: "enabled",
          observation: { status: "stopped" },
          native: { runtime: "codex", controls: { stop: "available" } },
        },
      ],
      operations: [],
      barrier: false,
      coverage: {},
    });
  }
  if (url.pathname.endsWith("/work")) {
    fixtureOperation = "verified";
    return json({
      items: [],
      operations: [{ id: "fixture-operation", state: fixtureOperation }],
      barrier: false,
      coverage: {},
    });
  }
  if (url.pathname === "/api/chats") {
    if (
      params.get("refreshError") &&
      rows.some((row) => row.archiveBatchId === "restored-fixture")
    )
      return new Response("Synthetic refresh error", { status: 503 });
    return json(rows.filter((row) => row.archivedAt));
  }
  if (url.pathname === "/api/agent-sessions") return json([]);
  if (url.pathname.endsWith("/native-archive/retry")) {
    rows.forEach((row) =>
      row.nativeArchive?.forEach((target) => {
        target.state = "archived";
        target.error = undefined;
      }),
    );
    return json({});
  }
  if (
    url.pathname === "/api/chats/archive" ||
    url.pathname === "/api/chats/unarchive"
  ) {
    const body = JSON.parse(String(init?.body));
    const ids: string[] =
      body.chatIds ||
      (body.batchId
        ? rows
            .filter((row) => row.archiveBatchId === body.batchId)
            .map((row) => row.id)
        : rows
            .filter(
              (row) =>
                !body.groupId ||
                layout.positions.some(
                  (position) =>
                    position.chatId === row.id &&
                    position.groupId === body.groupId,
                ),
            )
            .map((row) => row.id));
    const restore = url.pathname.endsWith("/unarchive");
    if (params.get("archiveError") && !body.dryRun && !restore)
      return new Response(
        JSON.stringify({ error: "Synthetic archive request failed" }),
        { status: 503 },
      );
    const blockers: ArchiveBlocker[] = restore
      ? []
      : rows
          .filter((row) => ids.includes(row.id) && row.status === "running")
          .map((row) => ({
            id: row.id,
            reason: "Stop it first",
            code: "running",
            action: "stop_session",
          }));
    if (
      !restore &&
      params.get("controls") &&
      fixtureOperation !== "verified" &&
      ids.includes("fixture-0")
    ) {
      const protectedChat = params.get("controls") === "protected";
      blockers.push({
        id: "fixture-0",
        code: protectedChat ? "issue_owned" : "work_shared",
        reason: "Legacy English reason",
        issueId: "iss_fixture",
        workTitle: "Shared synthetic preview server",
        action: protectedChat
          ? body.groupId
            ? "remove_from_folder"
            : undefined
          : params.get("controls") === "unlink"
            ? "unlink_work"
            : "stop_work",
        workId: "fixture-work",
        workSessionId: "fixture-owner",
        workRevision: 3,
        workReferenceRevision: 2,
      });
    }
    if (!body.dryRun && !blockers.length)
      rows.forEach((row) => {
        if (!ids.includes(row.id)) return;
        row.archivedAt = restore ? undefined : "2026-10-27T03:00:00Z";
        row.archivedByUser = "Synthetic user";
        row.archivedByLabel = "Synthetic user";
        row.archiveBatchId = restore ? "restored-fixture" : "fixture-batch";
        row.nativeArchive = [
          {
            provider: "codex",
            deviceId: "fixture-device",
            nativeSessionId: row.nativeSessionId!,
            desired: restore ? "active" : "archived",
            generation: 1,
            workspacePath: "/tmp/archive-fixture",
            state: params.get("native") === "failed" ? "failed" : "pending",
            error:
              params.get("native") === "failed"
                ? "Synthetic device failure"
                : undefined,
          },
        ];
      });
    return json({
      batchId: "fixture-batch",
      archived: ids,
      blockers,
      nativeAlsoHidden: [
        { id: "native-child", title: "Synthetic native subagent" },
      ],
      pausedWork:
        params.get("paused") === "1"
          ? [
              {
                id: "schedule",
                title: "Synthetic scheduled reminder",
                sessionId: ids[0],
              },
            ]
          : [],
    });
  }
  return json([]);
};
function Fixture() {
  const archive = useChatArchive("archive-fixture", true);
  const [view, setView] = useState("active");
  const [selected, setSelected] = useState(
    params.get("pane") === "thread" ? "fixture-0" : "",
  );
  const [revision, setRevision] = useState(0);
  window.onpopstate = () => {
    const id = location.pathname.split("/")[2] || "";
    setView(id === "archived" ? "archived" : "active");
    if (id !== "archived") setSelected(decodeURIComponent(id));
  };
  const chats: ChatListItem[] = rows
    .filter((row) => !archive.hidden.has(row.id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      status:
        row.status === "running"
          ? "processing"
          : row.status === "failed"
            ? "failed"
            : "idle",
      runtime: row.provider,
      unread: false,
      foundrySessionId: row.id,
      nativeSessionId: row.nativeSessionId,
      selected: selected === row.id,
      archiveBlocked: row.status === "running",
      onSelect: () => setSelected(row.id),
      onRename: async () => {},
      onAutoRename: async () => {},
      onMarkUnread: () => {},
      onNotify: () => {},
    }));
  const selectedArchive = archive.chats.find((row) => row.id === selected);
  return (
    <main className="fdy-chat-archive-fixture" data-revision={revision}>
      <div className="fdy-chat-archive-toolbar">
        <Button
          onClick={() => {
            if (rows[2]) rows[2].status = "completed";
            setRevision((value) => value + 1);
          }}
        >
          Stop synthetic running chat
        </Button>
        <Button
          onClick={() => setView(view === "active" ? "archived" : "active")}
        >
          Toggle fixture view
        </Button>
      </div>
      {view === "archived" ? (
        <ArchivedChatsView
          workspaceId="archive-fixture"
          chats={archivedChatRows(
            archive.chats,
            archive.sessions,
            archive.restored,
            {},
          )}
          busy={archive.busy}
          error={archive.error}
          readOnly={false}
          onUnarchive={(ids) => archive.change({ chatIds: ids }, true)}
          onRetry={archive.refresh}
        />
      ) : (
        <ChatSurface
          {...archiveSurfaceProps({
            chats,
            selectedChatId: selected,
            chatTitle: selected || "Archive fixture",
            threadKey: `archive-fixture:${selected || "new"}`,
            archiveCount: archivedChatRows(
              archive.chats,
              archive.sessions,
              archive.restored,
              {},
            ).length,
            onArchive: async ({ selectionAfterArchive: _, ...input }) => {
              await archive.change(input);
            },
            archiveToast: archive.undo
              ? {
                  id: archive.undo.batchId,
                  count: archive.undo.archived.length,
                  busy: archive.busy,
                  onUndo: () =>
                    archive
                      .change({ batchId: archive.undo?.batchId }, true)
                      .then(() => undefined),
                }
              : undefined,
            archiveBanner:
              selectedArchive && !archive.restored.has(selectedArchive.id) ? (
                <ChatArchiveBanner
                  chat={selectedArchive}
                  workspaceId="archive-fixture"
                  busy={archive.busy}
                  onUnarchive={() =>
                    archive.change({ chatIds: [selected] }, true)
                  }
                  onRefresh={archive.refresh}
                />
              ) : undefined,
          })}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);
