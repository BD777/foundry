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
import { errorMessage } from "./utils.js";

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
    if (message.method === "tools/call" && message.params)
      message.params.arguments = client.toolArguments(
        message.params.arguments ?? {},
      );
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
          message: errorMessage(error),
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
