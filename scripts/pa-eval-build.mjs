#!/usr/bin/env node
// Builds the Personal Agent routing and intent eval set (docs/personal-agent.md
// §13) from the dev database, de-identified, into ~/.foundry/pa-eval/set/ (private: it holds the person's own requests and project names, so it never goes into the repository):
//
//   cases.jsonl   one case per line, sorted by id:
//                 { id, origin: "real" | "handwritten", request, class, intent,
//                   at?, source?: { kind: "session" | "native", id },
//                   observed?: { workspaceId }, snapshot,
//                   gold: { class, target: <ws id> | "new" | "answer" | "ask",
//                           acceptable?: [ws ids], options?: [ws ids] },
//                   explicitRef?, note? }
//   index.json    the person's projects and computers as the assistant would
//                 see them (names, computer aliases, top-level files) and one
//                 L0 snapshot per ISO week: per project its five latest chat
//                 titles before that week, eval sources left out. A case's
//                 `snapshot` names the week it was asked in.
//
// Real cases are the first messages of chats the person started in their own
// projects (Foundry sessions and native Claude/Codex chats); the gold target is
// where they actually went, unless overrides.json says otherwise (answer it
// directly, ask, a project that fits better, or drop it). handwritten.json adds
// the cases real data cannot give: new projects, ambiguous requests, answers,
// memory and small talk; it names projects as "name@computer".
//
// The database is opened read-only. Names, emails, tokens, links, IPs, home
// paths and ids are replaced; person-specific patterns (real names, employer,
// device labels) come from a private file outside the repository,
// ~/.foundry/pa-eval/redact.json by default ({"replace": [[regex, text], ...],
// "devices": {"<label>": "<alias>"}}). A leak check fails the build when any
// of those, an account name or a raw secret shape survives.
//
// usage: node scripts/pa-eval-build.mjs [--db <path>] [--user <username>]
//          [--redact <file>] [--out <dir>] [--per-project N] [--max-real N]
//          [--list-candidates]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// The header comment above is the usage.
const usage = () =>
  readFileSync(import.meta.filename, "utf8")
    .split("\n")
    .slice(1)
    .filter((_, i, lines) =>
      lines.slice(0, i + 1).every((l) => l.startsWith("//")),
    )
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join("\n");

function parseArgs(argv) {
  const args = {
    db: resolve(homedir(), ".foundry/server/foundry.db"),
    user: "",
    redact: resolve(homedir(), ".foundry/pa-eval/redact.json"),
    out: resolve(homedir(), ".foundry/pa-eval/set"),
    perProject: 14,
    maxReal: 100,
    listCandidates: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--db") args.db = resolve(value());
    else if (flag === "--user") args.user = value();
    else if (flag === "--redact") args.redact = resolve(value());
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--per-project") args.perProject = Number(value());
    else if (flag === "--max-real") args.maxReal = Number(value());
    else if (flag === "--list-candidates") args.listCandidates = true;
    else if (flag === "-h" || flag === "--help") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

async function openReadOnly(path) {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  // node:sqlite is experimental in Node 24: keep its warning off stderr.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) =>
    String(warning).includes("SQLite")
      ? undefined
      : emit.call(process, warning, ...rest);
  const { DatabaseSync } = await import("node:sqlite");
  process.emitWarning = emit;
  return new DatabaseSync(path, { readOnly: true });
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// --- reading -----------------------------------------------------------------

function readPerson(db, username) {
  const users = db
    .prepare("SELECT id, username, display_name, role FROM users")
    .all();
  const person = username
    ? users.find((u) => u.username === username)
    : users.find((u) => u.role === "admin");
  if (!person) throw new Error(`no user ${username || "with role admin"}`);
  return { person, users };
}

function readProjects(db, personId) {
  const owned = new Set(
    db
      .prepare(
        "SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'owner'",
      )
      .all(personId)
      .map((r) => r.workspace_id),
  );
  const deleted = new Set(
    db
      .prepare("SELECT workspace_id FROM deleted_workspaces")
      .all()
      .map((r) => r.workspace_id),
  );
  const devices = new Map(
    db
      .prepare("SELECT id, label FROM devices")
      .all()
      .map((d) => [d.id, d.label]),
  );
  const projects = db
    .prepare(
      "SELECT id, name, local_path, device_id, payload_json FROM workspaces",
    )
    .all()
    .filter((w) => owned.has(w.id) && !deleted.has(w.id))
    .map((w) => {
      const payload = json(w.payload_json);
      return {
        id: w.id,
        name: w.name,
        localPath: w.local_path,
        deviceId: w.device_id,
        deviceLabel: devices.get(w.device_id) || payload.deviceLabel || "",
        kind: payload.kind || "project",
      };
    });
  const files = db
    .prepare("SELECT workspace_id, path, kind FROM workspace_files")
    .all();
  for (const project of projects) {
    project.files = files
      .filter((f) => f.workspace_id === project.id && !f.path.includes("/"))
      .map((f) => (f.kind === "directory" ? `${f.path}/` : f.path))
      .filter((p) => !/^\.(DS_Store|git\/|pytest_cache|foundry|venv)/.test(p))
      .sort();
  }
  return { projects, devices };
}

// The person's first message of every chat they started in their projects.
function readFirstMessages(db, personId, projectIds) {
  const items = [];
  for (const row of db
    .prepare(
      "SELECT id, workspace_id, created_at, payload_json FROM agent_sessions WHERE parent_session_id = ''",
    )
    .all()) {
    if (!projectIds.has(row.workspace_id)) continue;
    const p = json(row.payload_json);
    if (p.source !== "chat" || p.createdByUserId !== personId) continue;
    items.push({
      kind: "session",
      id: row.id,
      workspaceId: row.workspace_id,
      at: row.created_at,
      text: p.prompt || "",
      title: p.title || "",
    });
  }
  for (const row of db
    .prepare("SELECT id, workspace_id, title, payload_json FROM chats")
    .all()) {
    if (!projectIds.has(row.workspace_id)) continue;
    const p = json(row.payload_json);
    const transcript = Array.isArray(p.transcript) ? p.transcript : [];
    const firstUser = transcript
      .filter((m) => m && m.kind === "user")
      .map((m) => cleanText(m.text || ""))
      .find((t) => t !== null);
    const at = transcript.find((m) => m && m.at)?.at || p.updatedAt || "";
    items.push({
      kind: "native",
      id: row.id,
      workspaceId: row.workspace_id,
      at,
      text: firstUser ?? "",
      title: row.title || p.title || "",
      raw: true,
    });
  }
  return items;
}

// Every chat title per project with its time, for the L0 snapshots.
function readTitles(db, projectIds) {
  const titles = [];
  for (const row of db
    .prepare(
      "SELECT id, workspace_id, created_at, payload_json FROM agent_sessions WHERE parent_session_id = ''",
    )
    .all()) {
    if (!projectIds.has(row.workspace_id)) continue;
    const p = json(row.payload_json);
    if (p.source !== "chat") continue;
    titles.push({
      id: row.id,
      workspaceId: row.workspace_id,
      at: row.created_at,
      title: p.title || p.prompt || "",
    });
  }
  const named = new Map(
    db
      .prepare("SELECT chat_id, title FROM chat_titles")
      .all()
      .map((r) => [r.chat_id, r.title]),
  );
  for (const row of db
    .prepare("SELECT id, workspace_id, title, payload_json FROM chats")
    .all()) {
    if (!projectIds.has(row.workspace_id)) continue;
    const p = json(row.payload_json);
    const at =
      (Array.isArray(p.transcript) &&
        p.transcript.find((m) => m && m.at)?.at) ||
      p.updatedAt ||
      "";
    titles.push({
      id: row.id,
      workspaceId: row.workspace_id,
      at,
      title: named.get(row.id) || row.title || p.title || "",
    });
  }
  return titles;
}

// --- cleaning ----------------------------------------------------------------

// Wrappers a runtime or a tool put around the person's words, and test or
// title prompts that are not the person asking for anything.
const notAPersonRequest = [
  /^\s*</, // <local-command-caveat>, <pasted_content>, <codex_delegation>, ...
  /^\s*#\s*(Files|AGENTS\.md)/i,
  /^\s*\[Image: source/i,
  /^Base directory for this skill/i,
  /^This session is being continued/i,
  /^Context imported from/i,
  /^Codex native session$/i,
  /^请为下面会话最近两轮内容生成/,
  /^Write a title for the conversation/i,
  /^List the skills available/i,
  /^reply (with exactly )?OK/i,
  /^只回复/,
  /^不要使用任何工具/,
  /^运行 pwd/,
  /^把 settings-json-ok/,
  /^请调用 CronCreate/,
  /^Foundry context-window check/i,
  /^Create the file notes\/hello\.md/i,
  /^I need a screenshot of https:\/\/example\.com/i,
  /^你是并行执行子任务/,
  /^foundry timer e2e/i,
  /^Create an Agent with subagent_type/i,
  /^请把你对我上一条消息的回答写入/,
  /^你能创建另一个sub-session/i,
];

// null: not a request of the person's; otherwise the text with skill links
// and image markers reduced to what the person typed.
function cleanText(text) {
  if (typeof text !== "string") return null;
  let t = text.replace(/\r/g, "").trim();
  if (!t || notAPersonRequest.some((re) => re.test(t))) return null;
  t = t
    .replace(/\[\$([\w:.-]+)\]\([^)]*\)/g, "$$$1") // [$skill](path) -> $skill
    .replace(/\[Image #\d+\]\s*/gi, "[图片] ")
    .replace(/\[image\]\s*/gi, "[图片] ")
    // Pasted text and code blocks are someone else's words: keep the gist.
    .replace(
      /<pasted_content[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g,
      "（粘贴的内容）",
    )
    .replace(/```[\s\S]*?(```|$)/g, "（粘贴的内容）")
    .replace(/&#x20;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
  return t;
}

const tooVague = /^(hi|hello|继续|分析这个|```|好的?|ok|test|\.\.\.)$/i;

function meaningful(text) {
  if (!text) return false;
  const visible = text.replace(/[`\s]/g, "");
  if (visible.length < 6 || tooVague.test(text.trim())) return false;
  // Only an id, link or skill: nothing to route by.
  const words = text
    .replace(
      /https?:\/\/\S+|sess_\d+|codex:\/\/\S+|\$[\w:.-]+|[0-9a-f-]{16,}/gi,
      "",
    )
    .replace(/[\s\p{P}]/gu, "");
  return words.length >= 4;
}

// --- de-identification -------------------------------------------------------

const publicHosts =
  /(^|\.)(github\.com|x\.com|twitter\.com|xiaoyuzhoufm\.com|greenhouse\.io|claude\.ai|example\.com|yobiru\.com|umx\.com|okx\.com|bybit\.com|gate\.io|kucoin\.com|binance\.com|hyperliquid\.xyz|openai\.com|anthropic\.com|npmjs\.com)$/i;
const feishuHosts = /(feishu|larkoffice|larksuite|lark)\b/i;

function linkLabel(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "<链接>";
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "<内网地址>";
  if (/meego\./i.test(host)) return "<需求单链接>";
  if (feishuHosts.test(host)) return "<飞书链接>";
  if (publicHosts.test(host)) return `<${host.replace(/^www\./, "")} 链接>`;
  return "<内部链接>";
}

function makeRedactor(privateRules, accountNames) {
  // Shapes first (links, ids, paths), then the private patterns, then people
  // and chats, then account names.
  const shapes = [
    [
      /\b[\w.-]+@[\w.-]+:[\w./-]+/g,
      (m) =>
        `<git 仓库 ${m
          .split("/")
          .pop()
          .replace(/\.git$/, "")}>`,
    ],
    [/\S+:~\s+\S+\$/g, "<终端>$"],
    [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<邮箱>"],
    [/https?:\/\/[^\s)\]>"'，。“”]+/g, (url) => linkLabel(url)],
    [/codex:\/\/threads\/[\w-]+/g, "codex://threads/<id>"],
    [/\b(sk|pk|ghp|gho|xox[bap])[-_][\w-]{6,}/g, "<密钥>"],
    [/Bearer\s+[\w.-]+/gi, "Bearer <密钥>"],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<IP>"],
    [/\b\d{1,3}(\.\d{1,3}){0,2}\.{2,}/g, "<IP>…"], // cut short by a title
    [/\bsess_\d+\b/g, "sess_<id>"],
    [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<id>",
    ],
    [/\b[0-9a-f]{24,}\b/gi, "<id>"],
    [/\b\d{12,}[0-9A-Za-z]*\b/g, "<id>"],
    [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{24,}\b/g, "<id>"],
    [/(\/data\d*)?\/(home|Users)\/[^/\s]+/g, "~"],
  ];
  // People and chats named in quotes: who the person talked to, which group.
  const people = [
    [/(跟|和|与|给|同)\s*[“”"「]\**([^“”"「」\n]{1,12})[“”"」]/g, "$1“某人”"],
    [/@[^\s@,，。<]{1,20}/g, "@某人"],
  ];
  const extra = (privateRules || []).map(([pattern, text]) => [
    new RegExp(pattern, "gi"),
    text,
  ]);
  const names = accountNames
    .filter((n) => n && n.length >= 4)
    .map((n) => [
      new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "<用户>",
    ]);
  return (text) => {
    let out = text;
    for (const [re, to] of [...shapes, ...extra, ...people, ...names])
      out = out.replace(re, to);
    // In a message about Feishu chats, every quoted span names a chat or
    // quotes one: neither is the person's to publish.
    if (/飞书|群|对话|消息/.test(out))
      out = out.replace(
        /[“”"「]\**([^“”"「」\n]{1,80})\**[“”"」]/g,
        (m, inner) => (inner === "某人" ? m : "“某群”"),
      );
    return out.replace(/\n{3,}/g, "\n\n").trim();
  };
}

function leakCheck(texts, privateRules, accountNames, deviceLabels) {
  const shapes = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/, "email"],
    [/https?:\/\//, "link"],
    [/\b\d{1,3}(\.\d{1,3}){3}\b|\b\d{1,3}\.\d{1,3}\.?\.{2}/, "ip"],
    [/\b(sk|ghp|gho)[-_][\w-]{6,}/, "secret"],
    [/\/(home|Users)\/[^/\s<]+/, "home path"],
    [/\b[0-9a-f]{32,}\b/i, "hex id"],
  ];
  const named = [
    ...(privateRules || []).map(([pattern]) => [
      new RegExp(pattern, "i"),
      `private pattern ${pattern}`,
    ]),
    ...accountNames
      .filter((n) => n && n.length >= 4)
      .map((n) => [
        new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `account name ${n}`,
      ]),
    ...deviceLabels.map((l) => [
      new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      `device label ${l}`,
    ]),
  ];
  const hits = [];
  for (const { where, text } of texts) {
    for (const [re, what] of [...shapes, ...named])
      if (re.test(text)) hits.push(`${where}: ${what}`);
  }
  return hits;
}

// --- labelling ---------------------------------------------------------------

const intents = [
  [
    "session_followup",
    /sess_<id>|codex:\/\/threads|这个\s*session|这个 Codex Session/i,
  ],
  [
    "chat_digest",
    /(飞书|群).{0,30}(消息|总结|话题|对话|信息|看看)|(总结|阅读|看看|读).{0,20}(飞书|群)/,
  ],
  ["research", /调研|研究|综述|市面上|找找各个|价格如何|服务商/],
  [
    "ops",
    /部署|ssh|机器|磁盘|端口|安装|更新|升级|docker|NAS|配置|登录了|clash|subscription|effort|context window/i,
  ],
  [
    "debug",
    /为啥|为什么|报错|排查|不通|失败|panic|logid|log ID|根因|怎么回事|卡住|有没有问题|问题/i,
  ],
  ["analysis", /分析|曲线|收益|评估|回撤|亏损|杠杆|是否健康/],
  ["writing", /文档|简历|草拟|回复|撰写|整理一篇|部署指引|summary/i],
  [
    "build",
    /实现|做一个|做成|加(个|这个)?|接入|feature|新增|改为|创建|建个|web/i,
  ],
  ["question", /[?？]$|是什么|怎么|如何|哪里|哪个|多少|吗[?？]?$/],
];

function guessIntent(text) {
  for (const [name, re] of intents) if (re.test(text)) return name;
  return "task";
}

function guessClass(text, intent) {
  if (
    intent === "question" ||
    /^(.{0,40})(是什么|什么意思|怎么设置|如何)/.test(text)
  )
    return "question";
  return "task";
}

function isoWeek(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "unknown";
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day),
  );
  return monday.toISOString().slice(0, 10);
}

// Gold targets that are not a project: create one, answer directly, ask.
const specialTargets = new Set(["new", "answer", "ask"]);

const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "")
    .slice(0, 40);

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const db = await openReadOnly(args.db);
  const privateFile = existsSync(args.redact)
    ? json(readFileSync(args.redact, "utf8"))
    : {};
  if (!existsSync(args.redact))
    console.warn(
      `pa-eval-build: no private redaction file at ${args.redact}; only generic rules apply`,
    );
  const privateRules = Array.isArray(privateFile.replace)
    ? privateFile.replace
    : [];
  const deviceAliases = privateFile.devices || {};

  const { person, users } = readPerson(db, args.user);
  const { projects } = readProjects(db, person.id);
  const projectIds = new Set(projects.map((p) => p.id));
  const homeNames = [
    ...new Set(
      projects
        .map((p) => (/\/(?:home|Users)\/([^/]+)/.exec(p.localPath) || [])[1])
        .filter(Boolean),
    ),
  ];
  const accountNames = [
    ...new Set([
      ...users.flatMap((u) => [u.username, u.display_name]),
      ...homeNames,
    ]),
  ];
  const redact = makeRedactor(privateRules, accountNames);

  // Computer aliases: the private map first, then the label itself when it
  // carries nothing personal.
  const deviceLabels = [...new Set(projects.map((p) => p.deviceLabel))];
  const aliasOf = new Map();
  let unnamed = 0;
  for (const label of deviceLabels) {
    const alias =
      deviceAliases[label] ||
      (redact(label) === label && !/\d{3,}/.test(label)
        ? label
        : `computer-${++unnamed}`);
    aliasOf.set(label, alias);
  }
  const ref = (p) => `${redact(p.name)}@${aliasOf.get(p.deviceLabel)}`;
  const byRef = new Map(projects.map((p) => [ref(p), p]));
  if (byRef.size !== projects.length)
    throw new Error(
      "two projects share a name and computer alias; extend the device aliases",
    );

  // Candidates: the person's real first messages.
  const seen = new Set();
  const candidates = [];
  for (const item of readFirstMessages(db, person.id, projectIds).sort((a, b) =>
    a.at.localeCompare(b.at),
  )) {
    const text = item.raw ? item.text : cleanText(item.text);
    if (!meaningful(text)) continue;
    const key = `${item.workspaceId}:${normalize(text)}`;
    const keyAny = normalize(text).slice(0, 24);
    if (seen.has(key) || seen.has(keyAny)) continue;
    seen.add(key);
    seen.add(keyAny);
    const request = redact(text).slice(0, 400);
    candidates.push({ ...item, request });
  }

  const overridesPath = resolve(args.out, "overrides.json");
  const overrideFile = existsSync(overridesPath)
    ? json(readFileSync(overridesPath, "utf8"))
    : {};
  const overrides = overrideFile.cases || {};
  const handwrittenPath = resolve(args.out, "handwritten.json");
  const handwritten = existsSync(handwrittenPath)
    ? json(readFileSync(handwrittenPath, "utf8"))
    : { cases: [] };

  // Balanced, deterministic selection: at most perProject per project,
  // spread over time, then at most maxReal overall.
  const perProject = new Map();
  for (const c of candidates) {
    c.caseId = `real-${hash(`${c.kind}:${c.id}`)}`;
    if (overrides[c.caseId]?.exclude) continue;
    const list = perProject.get(c.workspaceId) || [];
    list.push(c);
    perProject.set(c.workspaceId, list);
  }
  let selected = [];
  for (const list of perProject.values()) {
    const forced = list.filter((c) => overrides[c.caseId]?.include);
    const rest = list.filter((c) => !overrides[c.caseId]?.include);
    const room = Math.max(0, args.perProject - forced.length);
    const step = rest.length / Math.max(room, 1);
    const picked =
      rest.length <= room
        ? rest
        : Array.from({ length: room }, (_, i) => rest[Math.floor(i * step)]);
    selected.push(...forced, ...picked);
  }
  selected.sort((a, b) => a.caseId.localeCompare(b.caseId));
  selected = selected.slice(0, args.maxReal);

  if (args.listCandidates) {
    for (const c of selected) {
      const p = projects.find((x) => x.id === c.workspaceId);
      console.log(
        `${c.caseId}\t${ref(p)}\t${c.request.replace(/\n/g, " ").slice(0, 160)}`,
      );
    }
    return;
  }

  const sameName = (p) =>
    projects
      .filter(
        (q) => q.id !== p.id && q.name === p.name && p.name !== "workspace",
      )
      .map((q) => q.id);
  const resolveRef = (value, where) => {
    if (specialTargets.has(value)) return value;
    const p = byRef.get(value) || projects.find((x) => x.id === value);
    if (!p)
      throw new Error(
        `${where}: unknown project ${value} (use name@computer: ${[...byRef.keys()].join(", ")})`,
      );
    return p.id;
  };

  const cases = [];
  for (const c of selected) {
    const o = overrides[c.caseId] || {};
    const project = projects.find((p) => p.id === c.workspaceId);
    const intent = o.intent || guessIntent(c.request);
    const klass = o.class || guessClass(c.request, intent);
    const target = o.target ? resolveRef(o.target, c.caseId) : c.workspaceId;
    const gold = { class: klass, target };
    const acceptable = o.acceptable
      ? o.acceptable.map((r) => resolveRef(r, c.caseId))
      : target === c.workspaceId
        ? sameName(project)
        : [];
    // Work the person spreads over several projects (Feishu chat digests):
    // any of them is right.
    const equivalent = (overrideFile.equivalent?.[intent] || []).map((r) =>
      resolveRef(r, `equivalent.${intent}`),
    );
    if (equivalent.includes(target))
      for (const id of equivalent)
        if (id !== target && !acceptable.includes(id)) acceptable.push(id);
    if (
      !specialTargets.has(target) &&
      target !== c.workspaceId &&
      !acceptable.includes(c.workspaceId)
    )
      acceptable.push(c.workspaceId);
    if (acceptable.length) gold.acceptable = acceptable;
    if (o.options) gold.options = o.options.map((r) => resolveRef(r, c.caseId));
    cases.push({
      id: c.caseId,
      origin: "real",
      request: o.request || c.request,
      class: klass,
      intent,
      at: c.at,
      source: { kind: c.kind, id: c.id },
      observed: { workspaceId: c.workspaceId },
      snapshot: isoWeek(c.at),
      gold,
      ...(/sess_<id>|codex:\/\/threads/.test(c.request) || o.explicitRef
        ? { explicitRef: true }
        : {}),
      ...(o.note ? { note: o.note } : {}),
    });
  }
  // Handwritten cases are asked "now": the latest week the data reaches.
  const latestWeek =
    cases
      .map((c) => c.snapshot)
      .sort()
      .at(-1) || "unknown";
  for (const h of handwritten.cases || []) {
    if (!h.id || !h.request || !h.gold)
      throw new Error(
        `handwritten case without id, request or gold: ${JSON.stringify(h).slice(0, 80)}`,
      );
    const gold = {
      class: h.gold.class,
      target: resolveRef(h.gold.target, h.id),
    };
    if (h.gold.acceptable)
      gold.acceptable = h.gold.acceptable.map((r) => resolveRef(r, h.id));
    if (h.gold.options)
      gold.options = h.gold.options.map((r) => resolveRef(r, h.id));
    cases.push({
      id: h.id,
      origin: "handwritten",
      request: h.request,
      class: h.gold.class,
      intent: h.intent || guessIntent(h.request),
      snapshot: latestWeek,
      gold,
      ...(h.scenario ? { scenario: h.scenario } : {}),
      ...(h.note ? { note: h.note } : {}),
    });
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
  }

  // L0 snapshots: per week a case was asked in, each project's five latest
  // chat titles before that week, never an eval case's own chat.
  const holdout = new Set(
    cases.filter((c) => c.source).map((c) => c.source.id),
  );
  const titles = readTitles(db, projectIds)
    .filter((t) => !holdout.has(t.id) && t.title && cleanText(t.title) !== null)
    .map((t) => ({
      ...t,
      title: redact(t.title).replace(/\s+/g, " ").slice(0, 80),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  const weeks = [...new Set(cases.map((c) => c.snapshot))].sort();
  const snapshots = {};
  for (const week of weeks) {
    snapshots[week] = projects.map((p) => ({
      workspaceId: p.id,
      recent: titles
        .filter((t) => t.workspaceId === p.id && t.at < week)
        .slice(0, 5)
        .map((t) => t.title),
    }));
  }

  const index = {
    version: 1,
    builtFrom:
      "dev database (read-only), de-identified; see scripts/pa-eval-build.mjs",
    projects: projects
      .map((p) => ({
        workspaceId: p.id,
        name: redact(p.name),
        ref: ref(p),
        computer: aliasOf.get(p.deviceLabel),
        kind: p.kind,
        files: p.files.map(redact),
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    snapshots,
  };

  const texts = [
    ...cases.map((c) => ({
      where: c.id,
      text: `${c.request} ${c.note || ""}`,
    })),
    ...Object.entries(snapshots).flatMap(([w, rows]) =>
      rows.map((r) => ({ where: `snapshot ${w}`, text: r.recent.join(" | ") })),
    ),
    ...index.projects.map((p) => ({
      where: `project ${p.ref}`,
      text: `${p.ref} ${p.files.join(" ")}`,
    })),
  ];
  const leaks = leakCheck(
    texts,
    privateRules,
    accountNames,
    deviceLabels.filter((l) => aliasOf.get(l) !== l),
  );
  if (leaks.length) {
    console.error(
      `pa-eval-build: ${leaks.length} possible leaks, nothing written:\n  ${leaks.slice(0, 40).join("\n  ")}`,
    );
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    resolve(args.out, "cases.jsonl"),
    cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );
  // The repository's formatter checks JSON: write it the way prettier would.
  const indexPath = resolve(args.out, "index.json");
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(indexPath)) || {};
  writeFileSync(
    indexPath,
    await prettier.format(JSON.stringify(index), {
      ...options,
      filepath: indexPath,
    }),
  );

  const count = (f) =>
    cases.reduce((m, c) => ((m[f(c)] = (m[f(c)] || 0) + 1), m), {});
  const targetKind = (c) =>
    specialTargets.has(c.gold.target) ? c.gold.target : "project";
  console.log(
    `pa-eval-build: ${cases.length} cases (${cases.filter((c) => c.origin === "real").length} real of ${candidates.length} candidates) -> ${dirname(resolve(args.out, "x"))}`,
  );
  console.log(`  gold target: ${JSON.stringify(count(targetKind))}`);
  console.log(`  class:       ${JSON.stringify(count((c) => c.class))}`);
  console.log(`  intent:      ${JSON.stringify(count((c) => c.intent))}`);
}

main().catch((error) => {
  console.error(`pa-eval-build: ${error.message}`);
  process.exit(1);
});
