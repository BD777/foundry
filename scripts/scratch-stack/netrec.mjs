// Records every network request (and SSE message) of all page targets of a
// Chrome with remote debugging into a JSONL file; /api/events totals every 30 s.
// For perf work on a scratch stack (scripts/scratch-stack.sh).
// usage: node scripts/scratch-stack/netrec.mjs <cdpPort> <out.jsonl>
import { appendFileSync } from "node:fs";
const [port, out] = process.argv.slice(2);
const targets = await (
  await fetch(`http://127.0.0.1:${port}/json/list`)
).json();
const attached = new Set();
async function attach(t) {
  if (t.type !== "page" || attached.has(t.id)) return;
  attached.add(t.id);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) =>
    ws.send(JSON.stringify({ id: ++id, method, params }));
  const reqs = new Map();
  ws.onopen = () => send("Network.enable");
  setInterval(() => {
    for (const r of reqs.values())
      if (r.url.includes("/api/events"))
        appendFileSync(
          out,
          JSON.stringify({
            sseTotal: true,
            url: r.url,
            wire: r.wire || 0,
            raw: r.raw || 0,
            wall: Date.now() / 1000,
            target: t.id.slice(0, 6),
          }) + "\n",
        );
  }, 30000);
  ws.onmessage = (m) => {
    const { method, params } = JSON.parse(m.data);
    if (!method) return;
    if (method === "Network.requestWillBeSent")
      reqs.set(params.requestId, {
        t0: params.timestamp,
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        wall: params.wallTime,
      });
    else if (method === "Network.responseReceived") {
      const r = reqs.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.fromCache = params.response.fromDiskCache;
        r.enc =
          params.response.headers["content-encoding"] ||
          params.response.headers["Content-Encoding"];
      }
    } else if (method === "Network.dataReceived") {
      const r = reqs.get(params.requestId);
      if (r) {
        r.wire = (r.wire || 0) + params.encodedDataLength;
        r.raw = (r.raw || 0) + params.dataLength;
      }
    } else if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      const r = reqs.get(params.requestId);
      if (!r) return;
      reqs.delete(params.requestId);
      appendFileSync(
        out,
        JSON.stringify({
          ...r,
          bytes: params.encodedDataLength ?? 0,
          ms: Math.round((params.timestamp - r.t0) * 1000),
          failed:
            method === "Network.loadingFailed" ? params.errorText : undefined,
          target: t.id.slice(0, 6),
        }) + "\n",
      );
    } else if (method === "Network.eventSourceMessageReceived") {
      appendFileSync(
        out,
        JSON.stringify({
          sse: params.eventName,
          len: params.data.length,
          wall: Date.now() / 1000,
          target: t.id.slice(0, 6),
        }) + "\n",
      );
    }
  };
}
for (const t of targets) await attach(t);
setInterval(async () => {
  for (const t of await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json())
    await attach(t);
}, 2000);
