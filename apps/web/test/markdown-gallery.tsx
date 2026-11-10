import { createRoot } from "react-dom/client";
import { ChatMessageRow } from "../src/components/conversation/chat-message-list";
import "../src/styles.css";

// One assistant message as a transcript shows it: paragraphs, headings, lists,
// framed blocks (table, wide table, code, diagram, image, quote) and what
// follows each. ?theme=dark|light, ?width=px.
const sample = `## 二、按 Brick 模块对一遍

| 候选 | 为什么不直接用 |
| --- | --- |
| MCP | 它的工具、资源、提示词是给模型看的；我们需要的是 Foundry 自己调用、Agent 看不到的管理调用（读状态、登录、登出、给会话准备环境）。它的 OAuth 规范明确不适用于本地 stdio。而且 2026-07-28 版去掉了 \`initialize\` 握手，大版本之间不兼容。 |
| **凭据助手类**（git、docker、kubectl exec、AWS \`credential_process\`、Google executable） | 都只是"一次性取一个 token"，没有登录流程、状态、安装，也没有会话期间常驻的进程。 |
| HashiCorp go-plugin（Terraform、Vault 在用） | 成熟，但每个插件要 gRPC + socket + 健康检查，以 Go 为中心，对 Node 写的 Worker 太重。 |

Numbers and status, with a wide table that has to scroll:

| Check | Result | Seconds | Files | Notes | Owner | Last run | Retries |
| :-- | :-: | --: | --: | :-- | :-- | :-- | --: |
| prettier | PASS | 3.8 | 106 | formatted nothing | CI | 2026-11-03 09:47 | 0 |
| tsc web | PASS | 121.3 | 1204 | project references | CI | 2026-11-03 09:47 | 0 |
| web tests | PASS | 141.1 | 67 | 1008 tests in total, none skipped | CI | 2026-11-03 09:49 | 1 |
| audit:ui | FAIL | 14.2 | 13 | \`audit:css\`: a colour is not in the palette | CI | 2026-11-03 09:52 | 2 |

\`\`\`ts
export function processToolDiff(item: ProcessDisplayRow): ProcessToolDiff | undefined {
  if (item.kind !== "tool" || !item.detail) return undefined;
  const input = firstFencedJSON(detailAfterSnippet(item.detail, item.snippet));
  if (!input) return undefined;
  // A single replacement, a list of them, or a whole new file.
  return replacement(input) ?? created(input);
}
\`\`\`

\`\`\`bash
scripts/check-changed.sh --files apps/web/src/features/chat/chat.css
PATH=/tmp/pnpm-shim:$PATH corepack pnpm --filter @foundry/web remove @radix-ui/react-scroll-area
\`\`\`

\`\`\`json
{ "build": "ac2b9cdf1825eba0", "previous": "feda616b390d0503" }
\`\`\`

\`\`\`diff
- padding: 18px 18px 20px 0;
+ padding: 18px 18px 20px 4px;
\`\`\`

Inline \`code\` and a short table that does not need the room:

| a | b |
| - | - |
| 1 | 2 |

A paragraph, then a diagram:

\`\`\`mermaid
graph TD
  A[Question] --> B{Answer?}
  B -->|yes| C[Done]
  B -->|no| A
\`\`\`

After the diagram, an image:

<image path="/gallery/figure.png" name="A generated figure">

After the image, a quote:

> A quoted panel that reads as part of the answer.
> Its second line.

The paragraph after the quote, then a list:

- one
- two
  - nested
- three

Two paragraphs in a row, the first.

The second paragraph.

A lead-in for a numbered list:

1. first step
2. second step

## A heading

Closing text.
`;

// The gallery has no server: images come from a canvas.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/api/local-files/image")) return realFetch(input, init);
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 200;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#8aa4d6";
  context.fillRect(0, 0, 480, 200);
  context.fillStyle = "#ffffff";
  context.font = "28px sans-serif";
  context.fillText("figure 480 x 200", 24, 110);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/png"),
  );
  return new Response(blob, { headers: { "content-type": "image/png" } });
};

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "dark" ? "dark" : "light";
const width = Number(params.get("width") ?? 720);

createRoot(document.getElementById("root")!).render(
  <main
    className="mx-auto min-h-dvh max-w-full bg-panel px-6 py-8"
    style={{ width }}
  >
    <div className="flex min-h-0 flex-col [--fdy-chat-content-max:720px] [--fdy-chat-content-padding:0px]">
      <ChatMessageRow
        message={{
          copyText: sample,
          id: "gallery",
          kind: "message",
          role: "bot",
          text: sample,
        }}
      />
    </div>
  </main>,
);
