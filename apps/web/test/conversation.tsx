import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../src/components/conversation/conversation";
import type {
  ChatMessageItem,
  ConversationComposer,
} from "../src/components/conversation/conversation-types";
import { Button } from "../src/components/ui/button";
import "../src/styles.css";
import "./conversation.css";

const noop = () => {};
function Fixture() {
  const [mode, setMode] = useState<"fixed" | "selectable">("fixed");
  const [narrow, setNarrow] = useState(false);
  const [runtime, setRuntime] = useState<"claude" | "codex">("claude");
  const [active, setActive] = useState(false);
  const [execution, setExecution] = useState("0");
  const [failure, setFailure] = useState(false);
  const [theme, setTheme] = useState("light");
  const [readOnly, setReadOnly] = useState(false);
  const [calls, setCalls] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessageItem[]>([
    {
      id: "goal",
      role: "user",
      text: "Keep Chat and Issue conversations consistent.",
    },
  ]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const composer: ConversationComposer =
    mode === "fixed"
      ? { mode, runtime, model: "test-model" }
      : {
          mode,
          agentValue: runtime,
          agentOptions: [
            { value: "claude", label: "Claude", runtime: "claude" },
            { value: "codex", label: "Codex", runtime: "codex" },
          ],
          onAgentChange: (value) => setRuntime(value as typeof runtime),
          runtimeControls: {
            selectedRuntime: runtime,
            claudeEffort: "max",
            claudePermissionMode: "default",
            codexApprovalPolicy: "never",
            codexReasoningEffort: "",
            codexSandboxMode: "workspace-write",
            codexSpeed: "standard",
            modelLoadFailed: false,
            modelLoading: false,
            modelOptions: [],
            modelValue: "test-model",
            onClaudeEffortChange: noop,
            onClaudePermissionModeChange: noop,
            onCodexApprovalPolicyChange: noop,
            onCodexReasoningEffortChange: noop,
            onCodexSandboxModeChange: noop,
            onCodexSpeedChange: noop,
            onModelChange: noop,
            onResetControls: noop,
          },
        };
  return (
    <main className="conversation-fixture" data-narrow={narrow}>
      <nav>
        <Button onClick={() => setNarrow(!narrow)}>
          Narrow: {String(narrow)}
        </Button>
        <Button
          onClick={() => setMode(mode === "fixed" ? "selectable" : "fixed")}
        >
          Mode: {mode}
        </Button>
        <Button
          onClick={() => setRuntime(runtime === "claude" ? "codex" : "claude")}
        >
          Runtime: {runtime}
        </Button>
        <Button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Theme: {theme}
        </Button>
        <Button onClick={() => setFailure(!failure)}>
          Failure: {String(failure)}
        </Button>
        <Button
          onClick={() => {
            setActive(false);
            setMessages((items) =>
              items.map((item) => ({ ...item, streaming: false })),
            );
          }}
        >
          Finish response
        </Button>
        <Button
          onClick={() =>
            setMessages((items) =>
              items.map((item) =>
                item.streaming
                  ? { ...item, text: `${item.text} · more output` }
                  : item,
              ),
            )
          }
        >
          Stream chunk
        </Button>
        <Button onClick={() => setReadOnly(!readOnly)}>
          Read only: {String(readOnly)}
        </Button>
        <output aria-label="Transport calls">{calls.join(" | ")}</output>
      </nav>
      <section>
        <Conversation
          threadKey="fixture"
          composer={composer}
          messages={messages}
          active={active}
          activeExecutionId={execution}
          readOnly={
            readOnly ? <p>Accepted. Conversation retained.</p> : undefined
          }
          onSend={async (text) => {
            setCalls((items) => [...items, `send:${text}`]);
            if (failure) throw new Error("Simulated offline; draft retained");
            const id = crypto.randomUUID();
            setExecution(id);
            setActive(true);
            setMessages((items) => [
              ...items,
              { id: `${id}:user`, role: "user", text },
              {
                id: `${id}:reply`,
                role: "bot",
                text: "Streaming reply",
                streaming: true,
              },
            ]);
            return true;
          }}
          onSteer={async (text, id) => {
            setCalls((items) => [...items, `steer:${text}`]);
            if (id !== execution) throw new Error("Wrong execution");
            setMessages((items) => [
              ...items,
              { id: crypto.randomUUID(), role: "user", text },
            ]);
            return true;
          }}
          onStop={async () => {
            setCalls((items) => [...items, "stop"]);
            setActive(false);
          }}
        />
      </section>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
