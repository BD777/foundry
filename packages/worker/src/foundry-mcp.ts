/**
 * `foundry mcp` — a stdio-only MCP server exposing session orchestration
 * (CHAT-01) to the native agent running in a Foundry session.
 *
 * It implements the small JSON-RPC subset MCP requires (initialize /
 * tools/list / tools/call / ping) with no third-party dependency, and is
 * deliberately stateless: credentials come from the environment.
 */

import {
  FoundryClient,
  FoundryClientError,
  resolveConfig,
} from "./foundry-client.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "foundry";
const SERVER_VERSION = "0.1.0";

const TERMINAL_STATUSES = ["completed", "failed", "canceled"];

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: Tool[] = [
  {
    name: "list_profiles",
    description:
      "List the agent profiles this device can run (provider, model, status). Optional runtime filter: claude|codex.",
    inputSchema: {
      type: "object",
      properties: { runtime: { type: "string" } },
    },
  },
  {
    name: "list_models",
    description: "List the model catalog advertised by one profile's endpoint.",
    inputSchema: {
      type: "object",
      properties: { profileId: { type: "string" } },
      required: ["profileId"],
    },
  },
  {
    name: "create_session",
    description:
      "Create a new Foundry session on this device and deliver it a task. The new session joins this session's orchestration group automatically. Returns immediately once queued unless wait=true. NOTE: parallel sessions writing the same repository race — split independent work and keep one writer per target. Codex cannot steer an active turn (the message queues for the next turn).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task brief for the new session.",
        },
        profileId: { type: "string" },
        provider: { type: "string", enum: ["claude", "codex"] },
        model: { type: "string" },
        claudeEffort: { type: "string" },
        claudePermissionMode: { type: "string" },
        codexReasoningEffort: { type: "string" },
        codexSandboxMode: { type: "string" },
        codexApprovalPolicy: { type: "string" },
        codexSpeed: { type: "string" },
        importedContext: { type: "string" },
        verification: {
          type: "boolean",
          description:
            "Run a read-only independent verifier (no Write/Edit/Bash); use for checking another session's work.",
        },
        forkSessionId: {
          type: "string",
          description:
            "Fork: resume another session's native transcript in a brand new thread.",
        },
        issueId: {
          type: "string",
          description:
            "Optional Issue id: run the session inside that Issue's candidate worktree for safe parallel writes (requires an active issue run).",
        },
        wait: {
          type: "boolean",
          description: "Block until the session reaches a terminal state.",
        },
        timeoutMs: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List sessions in this workspace (id, title, status, parentSessionId). Use to see what exists before creating or acting.",
    inputSchema: {
      type: "object",
      properties: {
        parentOnly: {
          type: "boolean",
          description: "Only sessions created by this session.",
        },
      },
    },
  },
  {
    name: "list_group_sessions",
    description:
      "List every session in one orchestration group, in list order. A replacement orchestrator uses this to take over a group without lineage transfer.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string" } },
      required: ["groupId"],
    },
  },
  {
    name: "get_session",
    description:
      "Get one session's current summary (status, title, latest response).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "read_context",
    description:
      "Read another session's context. scope=summary (default, cheap), thread (all turns of the conversation), transcript (raw native chat), or subagents. Output is tail-truncated by maxBytes to protect your context window.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        scope: {
          type: "string",
          enum: ["summary", "thread", "transcript", "subagents"],
        },
        taskId: {
          type: "string",
          description: "Required for a single subagent transcript.",
        },
        maxBytes: { type: "number", description: "Default 12000." },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "handoff_session",
    description:
      "Replace a polluted session: start a fresh session carrying only a factual handoff (goal, last result, status) plus your instruction — never the raw transcript.",
    inputSchema: {
      type: "object",
      properties: {
        fromSessionId: { type: "string" },
        prompt: {
          type: "string",
          description: "Instructions for the replacement session.",
        },
        profileId: { type: "string" },
        issueId: { type: "string" },
      },
      required: ["fromSessionId", "prompt"],
    },
  },
  {
    name: "steer_session",
    description:
      "Send an additional instruction to a running session you created. It adjusts the active turn (Claude) or queues for the next turn (Codex).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        message: { type: "string" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "cancel_session",
    description:
      "Stop a running or queued session you created. Cancelling never cascades: sessions it created keep running as independent first-class sessions.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "wait_session",
    description:
      "Block until a session reaches one of the requested statuses (default: completed/failed/canceled) or the timeout elapses. Prefer this over polling loops.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        until: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "number" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "rename_session",
    description: "Rename a session you created (1–120 characters).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, title: { type: "string" } },
      required: ["sessionId", "title"],
    },
  },
];

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncate(value: unknown, maxBytes: number): string {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  text = buffer.subarray(0, maxBytes).toString("utf8");
  return `${text}\n…[truncated at ${maxBytes} bytes]`;
}

export async function runMcpServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  let client: FoundryClient;
  try {
    client = new FoundryClient(resolveConfig());
  } catch (error) {
    // Fail startup clearly; the agent sees the reason in its MCP error.
    throw error;
  }

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    switch (name) {
      case "list_profiles":
        return client.listProfiles(str(args.runtime));
      case "list_models":
        return client.listModels(str(args.profileId));
      case "create_session": {
        const session = await client.createSession({
          prompt: str(args.prompt),
          profileId: str(args.profileId),
          provider: str(args.provider),
          model: str(args.model),
          threadId: str(args.threadId),
          importedContext: str(args.importedContext),
          issueId: str(args.issueId),
          forkSessionId: str(args.forkSessionId),
          verification: bool(args.verification),
          claudeEffort: str(args.claudeEffort),
          claudePermissionMode: str(args.claudePermissionMode),
          codexReasoningEffort: str(args.codexReasoningEffort),
          codexSandboxMode: str(args.codexSandboxMode),
          codexApprovalPolicy: str(args.codexApprovalPolicy),
          codexSpeed: str(args.codexSpeed),
        });
        if (bool(args.wait)) {
          return client.waitFor(
            session.id,
            TERMINAL_STATUSES,
            num(args.timeoutMs, 600_000),
          );
        }
        return session;
      }
      case "list_sessions": {
        const sessions = await client.listSessions();
        return bool(args.parentOnly)
          ? sessions.filter(
              (session) => session.parentSessionId === client.sessionId,
            )
          : sessions;
      }
      case "list_group_sessions":
        return client.listGroupSessions(str(args.groupId));
      case "get_session":
        return client.getSession(str(args.sessionId));
      case "read_context": {
        const maxBytes = num(args.maxBytes, 12_000);
        const scope = str(args.scope, "summary");
        const id = str(args.sessionId);
        let value: unknown;
        if (scope === "thread") value = await client.getThread(id);
        else if (scope === "transcript") value = await client.getChat(id);
        else if (scope === "subagents")
          value = args.taskId
            ? client.getSubagentTranscript(id, str(args.taskId))
            : await client.listSubagents(id);
        else value = await client.getSession(id);
        return truncate(await value, maxBytes);
      }
      case "handoff_session":
        return client.handoffSession({
          fromSessionId: str(args.fromSessionId),
          prompt: str(args.prompt),
          profileId: str(args.profileId),
          issueId: str(args.issueId),
        });
      case "steer_session":
        return client.steer(str(args.sessionId), str(args.message));
      case "cancel_session":
        return client.cancel(str(args.sessionId));
      case "wait_session": {
        const until =
          Array.isArray(args.until) && args.until.length
            ? (args.until as unknown[]).map(String)
            : TERMINAL_STATUSES;
        return client.waitFor(
          str(args.sessionId),
          until,
          num(args.timeoutMs, 600_000),
        );
      }
      case "rename_session":
        return client.rename(str(args.sessionId), str(args.title));
      default:
        throw new FoundryClientError(`unknown tool: ${name}`);
    }
  };

  const send = (message: Record<string, unknown>): void => {
    output.write(JSON.stringify(message) + "\n");
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
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      if (request.id === undefined || request.id === null) {
        // Notifications (e.g. notifications/initialized) need no response.
        continue;
      }
      try {
        if (request.method === "initialize") {
          send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            },
          });
        } else if (request.method === "ping") {
          send({ jsonrpc: "2.0", id: request.id, result: {} });
        } else if (request.method === "tools/list") {
          send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
        } else if (request.method === "tools/call") {
          const params = (request.params ?? {}) as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          const result = await callTool(
            str(params.name),
            params.arguments ?? {},
          );
          send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    typeof result === "string"
                      ? result
                      : JSON.stringify(result, null, 2),
                },
              ],
            },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: `method not found: ${request.method}`,
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message },
        });
      }
    }
  }
}
