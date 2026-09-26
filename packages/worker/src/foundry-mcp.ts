/**
 * `foundry mcp` — a stdio bridge to the server's Foundry tools (`/api/mcp`).
 *
 * The server owns the tool catalog and its policy; this bridge only carries
 * newline-delimited JSON-RPC between a stdio MCP client and that endpoint,
 * authenticated with the session token or this device's credential.
 */

import {
  FoundryClient,
  FoundryClientError,
  resolveConfig,
} from "./foundry-client.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export async function runMcpServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const client = new FoundryClient(resolveConfig());

  const forward = async (message: JsonRpcMessage): Promise<void> => {
    // Without a session token the server needs the workspace named; a paired
    // device supplies its configured one unless the caller chose another.
    const args = message.params?.arguments;
    if (
      message.method === "tools/call" &&
      client.workspaceId &&
      args &&
      !args.workspaceId
    ) {
      args.workspaceId = client.workspaceId;
    }
    let reply: unknown;
    try {
      reply = await client.mcp(message);
    } catch (error) {
      if (message.id === undefined || message.id === null) return;
      reply = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message:
            error instanceof FoundryClientError || error instanceof Error
              ? error.message
              : String(error),
        },
      };
    }
    if (reply !== undefined) output.write(JSON.stringify(reply) + "\n");
  };

  let buffer = "";
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      await forward(message);
    }
  }
}
