/**
 * A Codex executable for runtime install tests that keeps the native contract
 * Foundry's compatibility check relies on (Codex 0.166): the provider is the
 * process's own (`-c model_provider=...`), a thread stays on the provider it
 * started with, a fork may move it, and a turn sends the thread's history to
 * the endpoint of the thread's own provider definition (which takes
 * precedence over the process's) and reports the endpoint's answer. refuseTurns
 * stands for a release that breaks Foundry's flow.
 */
export function fakeCodexAppServer({
  version,
  calls,
  rejectModelList = false,
  refuseTurns = false,
}) {
  return `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("codex-cli ${version}"); process.exit(0); }
const conf = {};
for (let i = 0; i < argv.length; i++)
  if (argv[i] === "-c") { const s = argv[++i]; conf[s.slice(0, s.indexOf("="))] = s.slice(s.indexOf("=") + 1); }
const provider = JSON.parse(conf.model_provider ?? '"openai"');
const processBaseUrl = ((conf["model_providers." + provider] ?? "").match(/base_url = "([^"]+)"/) ?? [])[1];
const endpoint = (config) => { const own = config?.model_providers?.[provider]; return { baseUrl: own?.base_url ?? processBaseUrl, headers: own?.http_headers ?? {} }; };
const home = process.env.CODEX_HOME || process.env.HOME;
const file = (id) => path.join(home, "fake-thread-" + id + ".json");
const read = (id) => JSON.parse(fs.readFileSync(file(id), "utf8"));
const write = (id, thread) => fs.writeFileSync(file(id), JSON.stringify(thread));
const send = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
let sequence = 0;
const newId = () => "thread-" + process.pid + "-" + ++sequence;
require("node:readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  ${calls ? `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: m.method, home: process.env.HOME }) + "\\n");` : ""}
  const p = m.params ?? {};
  const reply = (result) => send({ id: m.id, result });
  const fail = (message, type) => send({ id: m.id, error: { code: -32600, message, ...(type ? { data: { type } } : {}) } });
  const pinned = (thread) => thread.provider === provider ? undefined : fail("This chat uses " + thread.provider + ", but your current provider is " + provider + ".", "modelProviderMismatch");
  if (m.method === "initialize" || m.method === "thread/inject_items") return reply({});
  if (m.method === "model/list") return ${rejectModelList} ? fail("bad candidate") : reply({ data: [] });
  if (m.method === "thread/start") { const id = newId(); write(id, { provider: p.config?.model_provider ?? provider, endpoint: endpoint(p.config), inputs: [] }); return reply({ thread: { id } }); }
  if (m.method === "thread/resume") { const thread = read(p.threadId); if (pinned(thread)) return; write(p.threadId, { ...thread, endpoint: endpoint(p.config) }); return reply({ thread: { id: p.threadId } }); }
  if (m.method === "thread/fork") { const id = newId(); write(id, { ...read(p.threadId), provider: p.config?.model_provider ?? provider, endpoint: endpoint(p.config) }); return reply({ thread: { id } }); }
  if (m.method === "turn/start") {
    const thread = read(p.threadId);
    if (${refuseTurns}) return fail("This chat uses x, but your current provider is openai.", "modelProviderMismatch");
    if (pinned(thread)) return;
    thread.inputs.push(p.input.map((part) => part.text).join(""));
    write(p.threadId, thread);
    const turn = "turn-" + ++sequence;
    reply({ turn: { id: turn } });
    const body = await (await fetch(thread.endpoint.baseUrl + "/responses", { method: "POST", headers: thread.endpoint.headers, body: JSON.stringify({ input: thread.inputs }) })).text();
    const text = (body.match(/"text":"([^"]*)"/) ?? [])[1] ?? "";
    send({ method: "item/completed", params: { threadId: p.threadId, turnId: turn, item: { id: "answer", type: "agentMessage", text, phase: "final_answer" } } });
    return send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: turn, status: "completed" } } });
  }
  fail("unsupported " + m.method);
});
`;
}
