/** Synthetic failures rendered through the real projection and conversation component. */
import { createRoot } from "react-dom/client";
import {
  executionHostStoppedError,
  type AgentSession,
} from "@bd777/foundry-protocol";
import { i18n } from "../../src/i18n";
import { ChatMessageRow } from "../../src/components/conversation/chat-message-list";
import { agentSessionFailureMessage } from "../../src/features/chat/chat-failure";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const errors = {
  host: executionHostStoppedError,
  disk: "ENOSPC: no space left on device, open '/synthetic/outbox'",
  rate: "invalid_request_error: throttle by model gateway: user tpm rate limit exceeded",
  skills:
    "Workspace draft scan timed out; reduce the draft package size and retry.",
  unknown: "Unexpected synthetic failure without a known cause",
};
const error =
  errors[params.get("scenario") as keyof typeof errors] ?? errors.host;
const session = {
  id: "synthetic",
  deviceId: "mac",
  provider: "codex",
  status: "failed",
  input: { id: "turn", prompt: "continue", at: "2026-10-23T04:00:00Z" },
  events: params.has("observation")
    ? [
        {
          id: "warning",
          sessionId: "synthetic",
          at: "2026-10-23T04:07:25Z",
          label: "Notice",
          level: "warning",
          detail:
            "Codex 0.163.0 background inventory unavailable: Error: ENOSPC: no space left on device, write",
        },
      ]
    : [],
} as AgentSession;
const failure = agentSessionFailureMessage(session, error, [
  { id: "mac", label: "MacBook" },
]);
createRoot(document.getElementById("root")!).render(
  <main className="fdy-chat-message-wrap">
    <ChatMessageRow
      message={{ id: "failure", kind: "failure", role: "bot", ...failure }}
    />
  </main>,
);
