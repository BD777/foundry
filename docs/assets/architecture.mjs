// Source of architecture.svg. Edit the data below, then run:
//   node docs/assets/architecture.mjs
// Layers read top-down; upper layers use lower ones. Dashed boxes are planned.
import { writeFileSync } from "node:fs";

const entries = [
  { title: "Web", note: "会话、Issue、设备与配置" },
  { title: "外部 Agent", note: "经 foundry CLI / MCP" },
  { title: "渠道入口", note: "飞书 Bot：群聊与单聊" },
];
const assistant = [
  { title: "跨 Workspace 路由", note: "判断落到哪里，按需新建" },
  { title: "派出与监督", note: "交给 Workspace 中的会话" },
  { title: "本身是一个 Workspace", note: "测试中" },
];
const workflows = [
  { title: "Chats", note: "直接写 Workspace · 由人把关" },
  { title: "Issues", note: "隔离 → 证据 → 接受 → 合入" },
  { title: "自定义工作流", note: "规划：基于基础能力的插件", planned: true },
];
const foundations = [
  {
    title: "执行",
    color: "#0f8a8f",
    items: ["原生 Agent 会话", "多设备与 Daemon", "Foundry MCP · CLI"],
  },
  {
    title: "隔离与合入",
    color: "#6d4fd0",
    items: ["Git worktree 候选", "Sandbox 写边界", "合入队列与冲突解决"],
  },
  {
    title: "验证",
    color: "#23854e",
    items: ["证据采集", "独立判定", "人工接受"],
  },
  {
    title: "能力供给",
    color: "#b83c7e",
    span: 2,
    items: ["Resources", "Skills", "模型与账号", "连接器", "渠道"],
  },
  {
    title: "信任",
    color: "#4b5563",
    items: ["身份与共享", "Workspace 角色", "凭据边界"],
  },
];

const W = 1240;
const labelX = 24;
const labelW = 128;
const x0 = 168;
const x1 = 1216;
const gap = 12;
const font =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const parts = [];
const label = (y, h, title, sub) =>
  parts.push(
    `<text x="${labelX + labelW / 2}" y="${y + h / 2 - (sub ? 4 : -5)}" class="layer">${esc(title)}</text>` +
      (sub
        ? `<text x="${labelX + labelW / 2}" y="${y + h / 2 + 15}" class="layer-sub">${esc(sub)}</text>`
        : ""),
  );

function cards(y, h, list, fill, stroke) {
  const w = (x1 - x0 - gap * (list.length - 1)) / list.length;
  list.forEach((c, i) => {
    const x = x0 + i * (w + gap);
    const dash = c.planned ? ' stroke-dasharray="6 4"' : "";
    const bg = c.planned ? "#ffffff" : fill;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${bg}" stroke="${stroke}" stroke-width="1.4"${dash}/>`,
      `<text x="${x + w / 2}" y="${y + h / 2 - 4}" class="card">${esc(c.title)}</text>`,
      `<text x="${x + w / 2}" y="${y + h / 2 + 16}" class="note">${esc(c.note)}</text>`,
    );
  });
}

let y = 24;
const rowH = 64;
label(y, rowH, "入口");
cards(y, rowH, entries, "#eaf2ff", "#4a7fd6");
y += rowH + 14;
label(y, rowH, "Personal Agent", "跨 Workspace");
cards(y, rowH, assistant, "#fff4e5", "#e08a00");
y += rowH + 14;
label(y, rowH + 6, "工作流", "基础能力的组合");
cards(y, rowH + 6, workflows, "#e8f6ee", "#2f9e5b");
y += rowH + 6 + 20;

// Foundations: one band, one column per group.
const itemH = 30;
const rows = (f) => Math.ceil(f.items.length / (f.span ?? 1));
const maxItems = Math.max(...foundations.map(rows));
const bandH = 22 + 30 + maxItems * (itemH + 8) + 8;
label(y, bandH, "基础能力", "Foundry 的核心");
parts.push(
  `<rect x="${x0 - 10}" y="${y - 10}" width="${x1 - x0 + 20}" height="${bandH + 20}" rx="14" fill="#f5f6f8" stroke="#d6dae1"/>`,
);
const units = foundations.reduce((n, f) => n + (f.span ?? 1), 0);
const unitW = (x1 - x0 - gap * (units - 1)) / units;
let fx = x0;
foundations.forEach((f) => {
  const span = f.span ?? 1;
  const x = fx;
  const colW = unitW * span + gap * (span - 1);
  fx += colW + gap;
  parts.push(
    `<rect x="${x}" y="${y}" width="${colW}" height="${bandH}" rx="10" fill="#ffffff" stroke="#e1e4e9"/>`,
    `<rect x="${x}" y="${y}" width="${colW}" height="34" rx="10" fill="${f.color}"/>`,
    `<rect x="${x}" y="${y + 24}" width="${colW}" height="10" fill="${f.color}"/>`,
    `<text x="${x + colW / 2}" y="${y + 22}" class="group">${esc(f.title)}</text>`,
  );
  const pillW = (colW - 24 - 10 * (span - 1)) / span;
  f.items.forEach((item, j) => {
    const px = x + 12 + (j % span) * (pillW + 10);
    const iy = y + 46 + Math.floor(j / span) * (itemH + 8);
    parts.push(
      `<rect x="${px}" y="${iy}" width="${pillW}" height="${itemH}" rx="7" fill="${f.color}" fill-opacity="0.08" stroke="${f.color}" stroke-opacity="0.35"/>`,
      `<text x="${px + pillW / 2}" y="${iy + 20}" class="item">${esc(item)}</text>`,
    );
  });
});
y += bandH + 10;

// Evolution loop between foundations and Workspace.
const mid = (x0 + x1) / 2;
parts.push(
  `<path d="M${mid - 150} ${y + 40} V${y + 8}" class="flow" marker-end="url(#arrow)"/>`,
  `<text x="${mid - 162}" y="${y + 29}" class="flow-label to-left">Workspace 构成 Agent 的上下文</text>`,
  `<path d="M${mid + 150} ${y + 8} V${y + 40}" class="flow" marker-end="url(#arrow)"/>`,
  `<text x="${mid + 162}" y="${y + 29}" class="flow-label to-right">接受的成果与方法合入 Workspace</text>`,
);
y += 50;

// Workspace: the base everything works on and evolves.
const wsH = 78;
label(y, wsH, "Workspace", "唯一真相源");
parts.push(
  `<rect x="${x0 - 10}" y="${y}" width="${x1 - x0 + 20}" height="${wsH}" rx="14" fill="url(#ws)"/>`,
  `<text x="${(x0 + x1) / 2}" y="${y + 33}" class="ws">Workspace · 项目的唯一真相源</text>`,
  `<text x="${(x0 + x1) / 2}" y="${y + 57}" class="ws-sub">代码、文档、数据、研究、小说……以及 Skill、工具与规则：它构成 Agent 的上下文，接受的成果与方法在这里一起演进</text>`,
);
y += wsH + 24;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Foundry 架构：入口、Personal Agent、工作流建立在基础能力之上，全部围绕 Workspace 演进">
<defs>
<linearGradient id="ws" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1f3a68"/><stop offset="1" stop-color="#2f62b0"/></linearGradient>
<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker>
<style>
text{font-family:${font};text-anchor:middle;fill:#1f2937}
.layer{font-size:15px;font-weight:700}
.layer-sub{font-size:12.5px;fill:#6b7280}
.card{font-size:17px;font-weight:600}
.note{font-size:13.5px;fill:#4b5563}
.group{font-size:15px;font-weight:700;fill:#ffffff}
.item{font-size:14px}
.ws{font-size:19px;font-weight:700;fill:#ffffff}
.ws-sub{font-size:14px;fill:#dbe7ff}
.flow{stroke:#94a3b8;stroke-width:2;fill:none}
.flow-label{font-size:13px;fill:#475569}
.to-left{text-anchor:end}
.to-right{text-anchor:start}
</style>
</defs>
<rect width="${W}" height="${H}" rx="16" fill="#ffffff"/>
${parts.join("\n")}
</svg>
`;
writeFileSync(new URL("./architecture.svg", import.meta.url), svg);
console.log(`architecture.svg ${W}x${H}`);
