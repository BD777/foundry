/** Synthetic quota only: no real account or provider is accessed. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import { ChatContextCard } from "../../src/features/chat/chat-context-card";
import { Button } from "../../src/components/ui/button";
import { AccountUsageWindows } from "../../src/components/account-usage-windows";
import { Panel } from "../../src/components/ui/panel";
import type { ChatContextCardData } from "../../src/features/chat/chat-types";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "codex";
// Reproduce the published CSS order as well as Vite's development order.
const productionCss = params.get("productionCss");
if (productionCss) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = productionCss;
  await new Promise<void>((resolve, reject) => {
    link.onload = () => resolve();
    link.onerror = () => reject(new Error("Fixture stylesheet could not load"));
    document.head.append(link);
  });
}

let calls = 0;
window.fetch = async () => {
  calls++;
  if (calls > 1 && scenario === "error")
    return new Response("{}", { status: 503 });
  await new Promise((r) => setTimeout(r, scenario === "slow" ? 1500 : 80));
  return new Response(
    JSON.stringify({
      runtime: scenario === "claude" ? "claude" : "codex",
      runtimeGeneration: "synthetic",
      quotaMayBeCached: scenario === "claude",
      authMode: scenario === "apikey" ? "api_key" : "subscription",
      status: "verified",
      quotaStatus: scenario === "unsupported" ? "unsupported" : "supported",
      source: "/synthetic",
      sources: ["/synthetic"],
      executionSource: "/synthetic",
      checkedAt: new Date(
        Date.now() - (scenario === "stale" ? 180000 : 0),
      ).toISOString(),
      plan: params.has("plan") ? params.get("plan") : "pro",
      message: "Synthetic fixture",
      usage:
        scenario === "unsupported"
          ? []
          : scenario === "single"
            ? [
                {
                  id: "weekly",
                  usedPercent: 14,
                  windowMinutes: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
                },
              ]
            : [
                {
                  id: "primary",
                  usedPercent: 25,
                  windowMinutes: 300,
                  resetsAt: Math.floor(Date.now() / 1000) + 3500,
                },
                {
                  id: "secondary",
                  usedPercent: 83,
                  windowMinutes: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400,
                },
                {
                  id: "model",
                  label: "Model with a longer native bucket name",
                  windowMinutes: 10080,
                },
                { id: "extra_usage", usedPercent: 0 },
              ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
function Fixture() {
  const [online, setOnline] = useState(true);
  const data = {
    changes: [],
    files: [],
    background: [],
    subagents: [],
    timers: [],
    sources: [],
    previews: [],
    status: {
      sessionId: "synthetic",
      runtime: "codex",
      context: { usedTokens: 180000, contextWindow: 1000000 },
      turns: 1,
      totals: {
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
        costTurns: 0,
      },
      compactions: 0,
    },
  } as ChatContextCardData;

  return (
    <main style={{ maxWidth: 1100, margin: "24px auto", padding: 16 }}>
      <h1>Synthetic conversation</h1>
      <Button onClick={() => setOnline(!online)}>
        Toggle device connection
      </Button>
      <div
        style={{
          display: "flex",
          gap: 24,
          alignItems: "start",
          flexWrap: "wrap",
        }}
      >
        <Panel style={{ padding: 20, flex: "1 1 300px" }}>
          The agent has finished the synthetic task. The adjacent Usage section
          reflects the whole subscription account.
          {params.has("default") ? (
            <AccountUsageWindows
              windows={[
                {
                  id: "default-week",
                  usedPercent: 14,
                  windowMinutes: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
                },
              ]}
            />
          ) : null}
        </Panel>
        <div
          style={{
            width: Number(params.get("width")) || 290,
            maxWidth: "100%",
          }}
        >
          <ChatContextCard
            data={data}
            accountUsage={{
              deviceId: "synthetic",
              profileId: "official",
              runtime: scenario === "claude" ? "claude" : "codex",
              generation: "synthetic",
              online,
            }}
          />
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
