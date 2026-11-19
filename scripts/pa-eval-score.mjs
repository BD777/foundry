// Scoring helpers of the Personal Agent eval (docs/personal-agent.md §13):
// what the assistant did with a request, from its tool calls and reply.
// Pure functions, so scripts/pa-eval-score.test.mjs can check them.

// Work the assistant starts: a helper session (create_session, send_message)
// or one of its list items' execute plans (dispatch_item, which names the
// workspace it runs in).
export const DISPATCH_TOOLS = [
  "create_session",
  "send_message",
  "dispatch_item",
];

// "Bash\n\n```json\n{...}\n```" -> { name, args }; MCP names lose their prefix.
// A call that failed still shows the decision: the scratch copy's projects
// sit on the person's own computers, which are offline here, so starting
// work there is refused; where the assistant tried to put it is what counts.
// The worker writes the input as two-space JSON cut at 1600 characters
// ("... truncated ..."); the fields that decide the score are read from the
// cut text when they come before the cut, and are missing otherwise.
export function parseToolEvent(event) {
  const message = event.message || {};
  if (
    message.kind !== "tool" ||
    (event.label !== "Used tool" && event.label !== "Tool failed")
  )
    return null;
  const detail = event.detail || message.text || "";
  const rawName = detail.split("\n", 1)[0].trim();
  const name = rawName.split(/__|\.|\/|:/).pop();
  const block = /```json\n([\s\S]*?)\n```/.exec(detail);
  let args = {};
  try {
    args = block ? JSON.parse(block[1]) : {};
  } catch {
    args = {};
    const truncated = /```json\n([\s\S]*)/.exec(detail)?.[1] || "";
    for (const key of ["workspaceId", "sessionId", "op"]) {
      const m = new RegExp(`^ {2}"${key}": "([^"]*)"`, "m").exec(truncated);
      if (m) args[key] = m[1];
    }
  }
  return { name, rawName, args, failed: event.label === "Tool failed" };
}

// needs_you operations that put a question on the person's list. Other
// operations are not questions: op list shows a system permission gate or a
// Feishu card the person clicks, which blocks the work but is not a choice the
// assistant asks for (PA-1 gold review, decided item 5: the route stands).
export const QUESTION_CARD_OPS = ["ask"];

// A question the assistant put on the person's list is a question the person
// sees, as much as one in the reply.
export function cardAsksIn(tools) {
  return tools.filter(
    (t) => t.name === "needs_you" && QUESTION_CARD_OPS.includes(t.args.op),
  ).length;
}

// Work the request started: a new project, or a dispatch to a project other
// than the assistant's own workspace.
function startedWork(tools, assistantWorkspace) {
  const created = tools.filter((t) => t.name === "create_workspace");
  const dispatched = tools
    .filter((t) => DISPATCH_TOOLS.includes(t.name))
    .map(
      (t) =>
        t.args.workspaceId ||
        (t.name === "create_session" ? assistantWorkspace : ""),
    )
    .filter(Boolean);
  const external = dispatched.filter((w) => w !== assistantWorkspace);
  return { created, external };
}

// The asks a request leaves the person to answer before the work goes on:
// each question card, plus the reply's ask when no work was started (an offer
// or a side question after started work is not blocking). The raw question
// mark count stays questionsIn.
export function blockingAsksOf(
  tools,
  reply,
  assistantWorkspace,
  { asks } = {},
) {
  const { created, external } = startedWork(tools, assistantWorkspace);
  const textAsks = typeof asks === "boolean" ? asks : questionsIn(reply) > 0;
  const textBlocking = textAsks && !created.length && !external.length;
  return cardAsksIn(tools) + (textBlocking ? 1 : 0);
}

export function questionsIn(reply) {
  const text = reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "");
  return (text.match(/？|\?(?=\s|$|["”』」)])/g) || []).length;
}

// What the assistant did with a request, from its tool calls and reply: a
// project or a creation is a dispatch tool call, an ask is a judged reading
// of the reply (`asks`, from --judge; without one, a question mark) or a
// question card. Anything else is an answer. A reply that names a project
// without a dispatch is still an answer: `mentionedProject` records it as a
// diagnostic only, never as the decision.
export function classifyOutcome(
  tools,
  reply,
  assistantWorkspace,
  projects = [],
  { asks } = {},
) {
  const { created, external } = startedWork(tools, assistantWorkspace);
  if (created.length)
    return { decision: "new", workspaceId: external[0] || "" };
  if (external.length) return { decision: "project", workspaceId: external[0] };
  const textAsks = typeof asks === "boolean" ? asks : questionsIn(reply) > 0;
  if (textAsks || cardAsksIn(tools) > 0) return { decision: "ask" };
  return {
    decision: "answer",
    mentionedProject: mentionedProjectOf(reply, tools, projects),
  };
}

// The one project a reply names: by name or ref, or by the computer of the
// one project its tool calls opened when it names no project.
export function mentionedProjectOf(reply, tools, projects) {
  const named = mentionedProjects(reply, projects);
  if (named.length === 1) return named[0];
  if (named.length) return "";
  return projectByComputer(reply, tools, projects);
}

// The offline projects a reply names, by the index's own names and refs
// (name@computer), with or without 『』 quotes. A name that is a whole token
// of the reply counts (a bare word may be something else: "Foundry", the
// product), so short ASCII names must be at least three characters. A name
// shared by several projects counts only when the reply also names the
// computer of exactly one of them; otherwise the reply names none.
const PRODUCT_NAMES = new Set(["foundry"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether `word` is a whole token of `text` (lower case): CJK words by
// substring, ASCII words of at least three characters between non-name
// characters.
function hasToken(text, word) {
  const w = word.toLowerCase().trim();
  if (w.length < 2) return false;
  if (!/^[\x00-\x7f]+$/.test(w)) return text.includes(w);
  if (w.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9_-])${escapeRe(w)}($|[^a-z0-9_-])`).test(text);
}

export function mentionedProjects(reply, projects) {
  const text = reply.toLowerCase();
  const quoted = (name) => {
    const n = name.toLowerCase().trim();
    return (
      n.length >= 2 &&
      new RegExp(`[『「“"‘'«]\\s*${escapeRe(n)}\\s*[』」”"’'»]`).test(text)
    );
  };
  const has = (word) => hasToken(text, word);
  // The product's own name is also the word the assistant uses for Foundry
  // itself: only a quoted "foundry" names the project.
  const matched = projects.filter(
    (p) =>
      quoted(p.name) ||
      (!PRODUCT_NAMES.has(p.name.toLowerCase().trim()) && has(p.name)) ||
      (p.ref && has(p.ref)),
  );
  const byName = new Map();
  for (const p of matched)
    byName.set(p.name, [...(byName.get(p.name) || []), p]);
  const named = [];
  for (const group of byName.values()) {
    const picked =
      group.length === 1
        ? group
        : group.filter((p) => p.device && has(p.device));
    if (picked.length === 1) named.push(picked[0].id);
    else return [];
  }
  return named;
}

// A reply that names no project but names a computer ("the folder is on your
// MacBook, which is offline") names the project the assistant itself looked
// into on that computer: its tool calls name the projects it opened. It
// counts when the reply names exactly one computer and exactly one of the
// offline projects its calls named sits there.
export function projectByComputer(reply, tools, projects) {
  const text = reply.toLowerCase();
  const touched = new Set(
    tools.map((t) => t.args?.workspaceId).filter(Boolean),
  );
  const computers = [
    ...new Set(projects.map((p) => p.device).filter(Boolean)),
  ].filter((d) => hasToken(text, d));
  if (computers.length !== 1) return "";
  const candidates = projects.filter(
    (p) => touched.has(p.id) && p.device === computers[0],
  );
  return candidates.length === 1 ? candidates[0].id : "";
}

// The judge's answer: a JSON array of verdicts. One malformed item (a key
// left out, an unescaped quote in a reason) must not lose the batch: each
// object is then read on its own, and from a broken one the fields a
// verdict needs (id and the true/false readings) are taken by name.
export function parseJudgeAnswer(text) {
  const array = /\[[\s\S]*\]/.exec(text || "")?.[0];
  if (!array) return [];
  try {
    return JSON.parse(array);
  } catch {
    const verdicts = [];
    for (const chunk of array.match(/\{[^{}]*\}/g) || []) {
      try {
        verdicts.push(JSON.parse(chunk));
        continue;
      } catch {}
      const id = /"id"\s*:\s*"([^"]+)"/.exec(chunk)?.[1];
      if (!id) continue;
      const verdict = { id };
      for (const key of ["plain", "multipleQuestions", "asks"]) {
        const m = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(chunk);
        if (m) verdict[key] = m[1] === "true";
      }
      verdicts.push(verdict);
    }
    return verdicts;
  }
}
