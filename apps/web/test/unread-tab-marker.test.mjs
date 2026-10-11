import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useUnreadTabMarker } =
  await import("../src/features/chat/use-chat-list-state.ts");
const { setDocumentChat, setDocumentPage } =
  await import("../src/lib/document-title.ts");

function Marker({ chats, openChatId }) {
  useUnreadTabMarker(chats, openChatId);
  return null;
}

test("✅ marks only the open chat's unseen answer, not other unread chats", async () => {
  setDocumentPage({ primary: "Chats", context: "ws" });
  setDocumentChat({ title: "Chat a", running: false });
  const root = createRoot(document.createElement("div"));
  const render = (chats, openChatId) =>
    act(async () => {
      root.render(React.createElement(Marker, { chats, openChatId }));
    });
  // Another chat is unread; the open one was read: no mark.
  await render(
    [
      { id: "a", status: "idle" },
      { id: "b", status: "unread" },
    ],
    "a",
  );
  assert.equal(document.title, "Chat a · ws — Foundry");
  // The open chat finished while the tab was hidden: marked.
  await render(
    [
      { id: "a", status: "unread" },
      { id: "b", status: "unread" },
    ],
    "a",
  );
  assert.equal(document.title, "✅ Chat a · ws — Foundry");
  // Seen: cleared, although another chat is still unread.
  await render(
    [
      { id: "a", status: "idle" },
      { id: "b", status: "unread" },
    ],
    "a",
  );
  assert.equal(document.title, "Chat a · ws — Foundry");
  await act(async () => root.unmount());
});
