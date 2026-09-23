import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Check } from "lucide-react";
import { Alert } from "../src/components/ui/alert";
import { Badge } from "../src/components/ui/badge";
import { Button } from "../src/components/ui/button";
import { ChecklistRow } from "../src/components/ui/checklist-row";
import { TextInput, Checkbox } from "../src/components/ui/field";
import { IconBox } from "../src/components/ui/icon-box";
import { InfoRow } from "../src/components/ui/info-row";
import { MetaPill } from "../src/components/ui/meta-pill";
import { Panel, SectionLabel } from "../src/components/ui/panel";
import { EmptyState } from "../src/components/ui/empty-state";
import { SelectMenu } from "../src/components/ui/select-menu";
import { SegmentedControl } from "../src/components/ui/segmented-control";
import { TerminalBlock } from "../src/components/ui/terminal-block";
import {
  MessageComposer,
  ComposerInput,
  ComposerFooter,
  ComposerSubmit,
} from "../src/components/ui/message-composer";
import { ChatMessageRow } from "../src/components/conversation/chat-message-list";
import { RepositoryList } from "../src/features/issue-detail/repository-list";
import "../src/styles.css";
import "./theme-gallery.css";

function Sample({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="theme-sample">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}
function Gallery() {
  const [theme, setTheme] = useState("dark");
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState("claude");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main className="theme-gallery">
      <header>
        <h1>Foundry components</h1>
        <Button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          Switch to {theme === "dark" ? "light" : "dark"}
        </Button>
      </header>
      <Sample title="Buttons and selection">
        <div className="theme-row">
          {(["primary", "secondary", "ghost", "icon"] as const).map(
            (variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ),
          )}
          <Button disabled>Disabled</Button>
          <SelectMenu
            ariaLabel="Gallery agent"
            value={selection}
            onChange={setSelection}
            options={[
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ]}
          />
          <SegmentedControl
            aria-label="Gallery view"
            value={selection}
            onValueChange={setSelection}
            options={[
              { value: "claude", label: "Board" },
              { value: "codex", label: "List" },
            ]}
          />
        </div>
      </Sample>
      <Sample title="Status and metadata">
        <div className="theme-row">
          {(
            ["neutral", "online", "brass", "warn", "slate", "error"] as const
          ).map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
          {(["neutral", "muted", "brass"] as const).map((tone) => (
            <MetaPill key={tone} tone={tone}>
              {tone}
            </MetaPill>
          ))}
        </div>
      </Sample>
      <Sample title="Panel and checklist variants">
        <div className="theme-grid">
          {(["surface", "soft", "inset", "flat"] as const).map((variant) => (
            <Panel key={variant} variant={variant} className="theme-panel">
              <SectionLabel>{variant}</SectionLabel>
              <ChecklistRow>Acceptance condition stays readable</ChecklistRow>
              <ChecklistRow marker="check" tone="success">
                Successful check
              </ChecklistRow>
              <ChecklistRow marker="info" tone="warning">
                Needs attention
              </ChecklistRow>
              <InfoRow label="Workspace" meta="main">
                Candidate retained
              </InfoRow>
            </Panel>
          ))}
        </div>
      </Sample>
      <Sample title="Alerts">
        <div className="theme-grid">
          {(["info", "success", "warning", "error"] as const).map((tone) => (
            <Alert key={tone} tone={tone} title={tone}>
              Readable status text in a matching surface.
            </Alert>
          ))}
        </div>
      </Sample>
      <Sample title="Icons, inputs and empty states">
        <div className="theme-row">
          {(
            [
              "dark",
              "brass",
              "device",
              "green",
              "muted",
              "neutral",
              "subtle",
            ] as const
          ).map((tone) => (
            <IconBox key={tone} tone={tone}>
              <Check />
            </IconBox>
          ))}
          <Checkbox aria-label="Enable setting" />
          <TextInput aria-label="Setting value" placeholder="Enter a setting" />
        </div>
        <EmptyState
          title="Nothing selected"
          body="Choose a workspace to get started."
        />
      </Sample>
      <Sample title="Chat, Markdown and tool details">
        <ChatMessageRow
          message={{
            id: "answer",
            role: "bot",
            text: "### Result\n\nA readable **answer** with [a link](https://example.com), `inline code`, and a table.\n\n> A quoted instruction.\n\n| Check | Status |\n|---|---|\n| Theme | Passed |\n\n```js\nconst theme = 'dark';\n```",
          }}
        />
        <ChatMessageRow
          message={{
            id: "failure",
            role: "bot",
            kind: "failure",
            recoverable: true,
            title: "Workspace preparation failed",
            text:
              "Repository discovery must finish before initialization: " +
              "vendor/skills: Submodule is not initialized; ".repeat(40),
          }}
        />
        <ChatMessageRow
          message={{
            id: "tool",
            role: "bot",
            kind: "process",
            text: "",
            processItems: [
              {
                title: "Read configuration",
                detail: "Theme tokens loaded",
                status: "completed",
              },
            ],
          }}
        />
      </Sample>
      <Sample title="Composer">
        <MessageComposer>
          <ComposerInput
            aria-label="Gallery message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onSubmit={() => setDraft("")}
            placeholder="Write a message…"
          />
          <ComposerFooter>
            <span>Claude</span>
            <ComposerSubmit
              aria-label="Send gallery message"
              onClick={() => setDraft("")}
            />
          </ComposerFooter>
        </MessageComposer>
      </Sample>
      <Sample title="Terminal">
        <TerminalBlock
          lines={[{ id: "line", prompt: "$", value: "pnpm test" }]}
        />
      </Sample>
      <RepositoryList
        environmentStatus="not_prepared"
        repositories={Array.from({ length: 837 }, (_, index) => ({
          path: `projects/repository-${index}`,
          status: "unprepared",
          availability: index < 39 ? "unavailable" : "ready",
          kind: index < 39 ? "submodule" : "independent",
          error:
            index < 39
              ? "Initialize this submodule in its source repository before requesting it."
              : undefined,
        }))}
      />
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Gallery />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
