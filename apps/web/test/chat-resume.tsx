import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscriptStage } from "../src/features/chat/chat-transcript-stage";
import { useChatScrollFollow } from "../src/features/chat/use-chat-scroll-follow";
import type { ChatMessageItem } from "../src/features/chat/chat-surface-types";
import "../src/styles.css";

const history: ChatMessageItem[] = Array.from({ length: 20 }, (_, index) => ({
  id: `history-${index}`,
  role: index % 2 ? "bot" : "user",
  text:
    index % 2
      ? "Historical answer.\n\n".repeat(80)
      : `Question ${index / 2 + 1}`,
}));

function Fixture() {
  const [messages, setMessages] = useState(history);
  const [narrow, setNarrow] = useState(false);
  const controller = useChatScrollFollow("old-session");
  return (
    <>
      <button
        onClick={() => {
          controller.followLatest();
          setMessages((current) => [
            ...current,
            {
              id: `new-${current.length}`,
              role: "user",
              text: "Continue the old session",
            },
          ]);
        }}
      >
        Resume old session
      </button>
      <button onClick={() => setMessages([])}>Clear for hydration</button>
      <button onClick={() => setMessages(history)}>Hydrate history</button>
      <button
        onClick={() =>
          setMessages((current) => {
            const last = current.at(-1);
            return last?.streaming
              ? [
                  ...current.slice(0, -1),
                  { ...last, text: `${last.text}\n\nMore streamed output.` },
                ]
              : [
                  ...current,
                  {
                    id: `answer-${current.length}`,
                    role: "bot",
                    streaming: true,
                    text: "Streaming response.",
                  },
                ];
          })
        }
      >
        Stream response
      </button>
      <button onClick={() => setNarrow((current) => !current)}>
        Toggle narrow layout
      </button>
      <output aria-label="Message count">{messages.length}</output>
      <div
        className="fdy-chat-conversation"
        style={{
          height: 650,
          width: narrow ? 500 : "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ChatTranscriptStage
          messages={messages}
          scrollController={controller}
          showScrollToLatest={controller.showScrollToLatest}
          threadKey="old-session"
        />
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
import.meta.hot?.dispose(() => root.unmount());
