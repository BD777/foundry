import { createRoot } from "react-dom/client";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import { Alert } from "../src/components/ui/alert";
import { Button } from "../src/components/ui/button";
import { HelpHint } from "../src/components/ui/help-hint";
import { SectionHeader } from "../src/components/ui/page-header";
import {
  SetupChecklist,
  SetupChecklistItem,
} from "../src/components/ui/setup-checklist";
import { DeviceExternalConnections } from "../src/features/profiles/device-external-connections";
import { SessionFileContent } from "../src/features/chat/detail/chat-detail-files";
import "../src/i18n";
import "../src/styles.css";

const device = {
  id: "dev_1",
  label: "byte-llm-gateway",
  status: "connected",
  owned: false,
} as unknown as DeviceProjection;
const rows = [
  {
    id: "p1",
    label: "Gateway model",
    runtime: "codex",
    model: "gpt-x",
    status: "unhealthy",
    check: { status: "failed", message: "no answer" },
    connector: { kind: "feishu", label: "Feishu" },
  },
] as unknown as AgentProfileProjection[];

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto grid max-w-[760px] gap-8 p-6">
    <section className="grid gap-3">
      <SectionHeader
        title="Configured on this device"
        description="Model connections configured on byte-llm-gateway."
        help={
          <HelpHint label="About checking connections">
            <p>Check sends one short conversation and uses model quota.</p>
          </HelpHint>
        }
      />
      <DeviceExternalConnections
        device={device}
        rows={rows}
        onRefresh={async () => {}}
      />
    </section>
    <SetupChecklist label="Readiness">
      <SetupChecklistItem
        title="Codex"
        state="needed"
        detail={
          <span>
            0.163.0-alpha.11, your own copy · 0.166.0 available.{" "}
            <HelpHint label="About your own copy">
              Foundry can’t update a copy you installed yourself.
            </HelpHint>
          </span>
        }
        action={<Button size="sm">Use Foundry-managed copy</Button>}
      />
    </SetupChecklist>
    <section className="max-w-[420px] border border-line p-4">
      <SessionFileContent
        file={{ kind: "missing", path: "/a/b.md" } as never}
        item={
          {
            id: "f",
            kind: "session-file",
            path: "/a/b.md",
            pending: true,
            deviceLabel: "sg-chaos",
          } as never
        }
        onRetry={() => {}}
      />
    </section>
    <Alert
      tone="warning"
      title="Device is offline"
      actions={<Button size="sm">Reconnect</Button>}
    >
      Reconnect it, then retry.
    </Alert>
  </main>,
);
