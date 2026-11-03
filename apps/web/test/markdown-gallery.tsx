import { createRoot } from "react-dom/client";
import { MarkdownContent } from "../src/components/conversation/markdown-content";
import "../src/styles.css";
import "./markdown-gallery.css";

// Tables and code as a transcript shows them; ?theme=dark|light, ?width=px.
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
`;

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "dark" ? "dark" : "light";
const width = Number(params.get("width") ?? 720);

createRoot(document.getElementById("root")!).render(
  <main
    className="markdown-gallery"
    data-candidate={params.get("candidate") ?? undefined}
    style={{ width }}
  >
    <div className="fdy-chat-conversation">
      <div className="fdy-chat-message-card" data-role="bot">
        <div className="fdy-chat-message-copy fdy-markdown">
          <MarkdownContent>{sample}</MarkdownContent>
        </div>
      </div>
    </div>
  </main>,
);
