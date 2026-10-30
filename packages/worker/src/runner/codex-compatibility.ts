/**
 * A Codex release is activated only after Foundry's own app-server flow works
 * on it. Codex changes its protocol and its checks between releases (0.166
 * began refusing turns whose provider was set only per thread), and unit tests
 * against a fake app-server cannot see that. The same CodexAppServerThread a
 * session uses runs here against a loopback Responses endpoint: no account,
 * no provider and no model inference are involved.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CodexAppServerThread } from "./codex-app-server.js";
import { codexEndpointConfig } from "./codex-options.js";

const answer = "FOUNDRY_COMPATIBILITY_OK";

interface LoopbackRequest {
  route: string;
  body: string;
  header?: string;
}

/** Sent only in the thread config, as a profile's credential headers are. */
const header = "x-foundry-compatibility";

function loopbackEndpoint(): Promise<{
  server: Server;
  url: string;
  requests: LoopbackRequest[];
}> {
  const requests: LoopbackRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      if (request.method !== "POST" || !path.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      requests.push({
        route: path.split("/")[1] ?? "",
        body,
        header: request.headers[header] as string | undefined,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      send("response.created", { response: { id: "compatibility" } });
      send("response.output_item.done", {
        item: {
          type: "message",
          role: "assistant",
          id: "compatibility",
          content: [{ type: "output_text", text: answer }],
        },
      });
      send("response.completed", {
        response: {
          id: "compatibility",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

async function turn(
  thread: CodexAppServerThread,
  prompt: string,
): Promise<void> {
  const { events } = await thread.runStreamed(prompt, {
    signal: AbortSignal.timeout(60_000),
  });
  let answered = false;
  for await (const event of events as AsyncIterable<any>) {
    if (event.type === "turn.failed")
      throw new Error(event.error?.message ?? "the turn failed");
    if (event.type === "item.completed" && event.item?.text === answer)
      answered = true;
  }
  if (!answered) throw new Error("the turn ended without the endpoint answer");
}

/**
 * Runs a new thread, a resumed thread and a resumed thread whose profile moved
 * to another endpoint, each in its own app-server as sessions do. The caller
 * holds the runtime maintenance gate.
 */
export async function verifyCodexCompatibility(
  executable: string,
  scratch: string,
): Promise<void> {
  const endpoint = await loopbackEndpoint();
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    CODEX_HOME: scratch,
    CODEX_API_KEY: "foundry-compatibility",
  };
  const options = {
    workingDirectory: scratch,
    approvalPolicy: "never",
    sandboxMode: "read-only",
    model: "foundry-compatibility",
    skipGitRepoCheck: true,
    runtimeGateHeld: true,
    rpcTimeouts: { initializeMs: 20_000, startupMs: 30_000, controlMs: 20_000 },
  };
  const config = (route: string) =>
    codexEndpointConfig(
      {
        runtime: "codex",
        connectionType: "openai_compatible",
        id: `compatibility_${route}`,
        label: `Compatibility ${route}`,
        codexProviderConfig: { http_headers: { [header]: route } },
      },
      `${endpoint.url}/${route}/v1`,
      true,
    );
  const step = async (
    name: string,
    route: string,
    id: string | undefined,
    prompt: string,
  ) => {
    const before = endpoint.requests.length;
    const thread = new CodexAppServerThread(
      executable,
      env,
      config(route),
      options,
      id,
    );
    try {
      await turn(thread, prompt);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sent = endpoint.requests.slice(before);
    if (!sent.length || sent.some((request) => request.route !== route))
      throw new Error(`${name}: the turn did not use the selected endpoint`);
    if (sent.some((request) => request.header !== route))
      throw new Error(
        `${name}: the endpoint did not receive the profile's headers`,
      );
    return { id: thread.id, sent };
  };
  try {
    const started = await step("new thread", "a", undefined, "first prompt");
    await step("resumed thread", "a", started.id, "second prompt");
    const moved = await step(
      "thread moved to another endpoint",
      "b",
      started.id,
      "third prompt",
    );
    if (!moved.sent.some((request) => request.body.includes("first prompt")))
      throw new Error(
        "thread moved to another endpoint: the conversation history was lost",
      );
  } catch (error) {
    throw new Error(
      `This Codex release failed Foundry's compatibility check (${error instanceof Error ? error.message : String(error)}); the current runtime stays active.`,
    );
  } finally {
    endpoint.server.closeAllConnections();
    await new Promise((done) => endpoint.server.close(() => done(undefined)));
  }
}
