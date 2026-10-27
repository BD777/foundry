/** Isolated transport; the actual transcript hook, merge, model and virtual list. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentSession, AgentSessionEvent } from "@bd777/foundry-protocol";
import "../../src/styles.css";
import "./chat-history.css";
import { i18n } from "../../src/i18n";
import { Button } from "../../src/components/ui/button";
import { ChatTranscriptStage } from "../../src/components/conversation/chat-transcript-stage";
import { useChatScrollFollow } from "../../src/components/conversation/use-chat-scroll-follow";
import { mergeLoadedAgentSession } from "../../src/lib/agent-session-events";
import { useChatTranscript } from "../../src/features/chat/use-chat-transcript";
import { ChatTranscriptHistory } from "../../src/features/chat/chat-transcript-history";
import {
  chatMessagesForThread,
  chatMessageItemId,
} from "../../src/features/chat/chat-model";
import type { TranscriptLoaderTransport } from "../../src/features/chat/chat-transcript-loader";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage("en");
document.documentElement.dataset.theme = params.get("theme") || "light";
const session = {
  id: "dev050-long",
  workspaceId: "dev050",
  provider: "codex",
  agentId: "synthetic",
  status: "completed",
  prompt: "DEV050 OPENING REQUEST",
  title: "DEV-050 long chat",
  startedAt: "2026-10-27T00:00:00Z",
  completedAt: "2026-10-27T00:10:40Z",
  response: "Synthetic answer 639",
  createdLabel: "test",
  updatedLabel: "test",
} as AgentSession;
const events: AgentSessionEvent[] = Array.from({ length: 640 }, (_, i) => ({
  id: `event-${i}`,
  sessionId: session.id,
  at: new Date(Date.parse(session.startedAt!) + i * 1000).toISOString(),
  label: i % 2 === 0 ? "User message" : "Response",
  level: "info",
  detail: "",
  message: {
    id: `message-${i}`,
    kind: i % 2 === 0 ? "user" : "assistant",
    text:
      i === 0
        ? session.prompt
        : i % 2 === 0
          ? `Synthetic follow-up ${i}`
          : `Synthetic answer ${i}`,
  },
}));
// Many real windows contain tool events folded into one short process row.
if (params.has("compact")) {
  for (let i = 1; i < 638; i++) {
    events[i] = {
      ...events[i]!,
      label: "Tool",
      detail: `Synthetic trace ${i}`,
      message: undefined,
    };
  }
}
let calls = 0;
let failNext = params.has("fail");
const page = (end: number) => ({
  ...session,
  events: events.slice(Math.max(0, end - 200), end),
  eventsBefore: end > 200 ? String(end - 200) : undefined,
  eventsAfter: String(end),
});
const transport: TranscriptLoaderTransport = {
  loadRecent: async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 100));
    return [page(640)];
  },
  loadEarlier: async (_, before) => {
    calls++;
    await new Promise((r) => setTimeout(r, 450));
    if (failNext) {
      failNext = false;
      throw new Error("Synthetic page failure");
    }
    return page(Number(before));
  },
};
function Fixture() {
  const [selected, setSelected] = useState(true);
  const [cached, setCached] = useState(session);
  const history = useChatTranscript({
    workspaceId: "dev050",
    threadId: selected ? session.id : undefined,
    sessions: selected ? [cached] : [],
    transport,
    onLoaded: (loaded) =>
      setCached((previous) =>
        loaded.reduce(
          (current, next) => mergeLoadedAgentSession(current, next),
          previous,
        ),
      ),
  });
  const key = selected ? session.id : "other";
  const scroll = useChatScrollFollow(key);
  const messages = selected
    ? chatMessagesForThread({
        id: session.id,
        sessions: [cached],
      } as Parameters<typeof chatMessagesForThread>[0]).map((m, i) => ({
        ...m,
        id: chatMessageItemId(m, i),
      }))
    : [];
  return (
    <main
      className="dev050-history-fixture fdy-chat-conversation"
      data-events={cached.events?.length ?? 0}
      data-calls={calls}
    >
      <header>
        <h1>DEV-050 synthetic long chat</h1>
        <Button onClick={() => setSelected((value) => !value)}>
          {selected ? "Leave chat" : "Return to chat"}
        </Button>
      </header>
      <ChatTranscriptStage
        threadKey={key}
        messages={messages}
        scrollController={scroll}
        showScrollToLatest={scroll.showScrollToLatest}
        onReachHistoryStart={history.loadEarlier}
        history={
          <ChatTranscriptHistory
            state={history.state}
            onLoadEarlier={history.loadEarlier}
            onRetry={history.retry}
          />
        }
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
