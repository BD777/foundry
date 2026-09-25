import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { redactSecrets } from "../secret-redaction.js";
import { resolveClaudeCommand } from "../utils.js";
import type { HarnessAdapter } from "./harness.js";

/** Claude Agent SDK session in a private config directory. */
export const claudeHarness: HarnessAdapter = {
  async run({
    spec,
    policy,
    profile,
    home,
    env,
    sandboxedExecutable,
    signal,
    note,
  }) {
    const model = spec.model || profile.model;
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ])
      if (model) env[key] = model;
    const config = resolve(home, ".claude");
    mkdirSync(config, { mode: 0o700 });
    const auth = resolve(
      process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
      ".credentials.json",
    );
    if (existsSync(auth))
      copyFileSync(auth, resolve(config, ".credentials.json"));
    env.CLAUDE_CONFIG_DIR = config;
    const sdkName = "@anthropic-ai/claude-agent-sdk";
    const sdk = (await import(sdkName)) as {
      query: (args: {
        prompt: AsyncIterable<unknown>;
        options: Record<string, unknown>;
      }) => AsyncIterable<Record<string, unknown>>;
    };
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    const messages = async function* () {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: spec.prompt.text },
            ...spec.prompt.images.map((image) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: image.mimeType,
                data: image.bytes.toString("base64"),
              },
            })),
          ],
        },
      };
    };
    const workspace = spec.workspace;
    let text = "";
    let reportedModel: string | undefined;
    let sessionId: string | undefined;
    let structured: unknown;
    let diagnostic = "";
    try {
      for await (const message of sdk.query({
        prompt: messages(),
        options: {
          cwd: workspace?.path ?? home,
          env,
          pathToClaudeCodeExecutable: sandboxedExecutable(
            resolveClaudeCommand(),
          ),
          model,
          systemPrompt: spec.systemPrompt,
          // Read-only inspection tools inside the directory. The listed tools
          // are pre-approved; anything else falls through to canUseTool below
          // and is denied. Writes are refused by the sandbox regardless.
          tools: workspace ? { type: "preset", preset: "claude_code" } : [],
          allowedTools: policy.tools,
          disallowedTools: policy.deniedTools,
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: policy.projectInstructions ? ["project"] : [],
          skills: [],
          plugins: [],
          agents: {},
          persistSession: false,
          title: spec.title,
          maxTurns: policy.maxTurns,
          ...(spec.responseSchema
            ? {
                outputFormat: {
                  type: "json_schema",
                  schema: spec.responseSchema,
                },
              }
            : {}),
          abortController: abort,
          canUseTool: async (tool: string, input: Record<string, unknown>) =>
            policy.tools.includes(tool)
              ? { behavior: "allow", updatedInput: input }
              : {
                  behavior: "deny",
                  message: `${tool} is not available to this stage session`,
                },
          stderr: (chunk: string) => {
            if (diagnostic.length < 16000) diagnostic += chunk;
          },
        },
      })) {
        if (typeof message.session_id === "string" && message.session_id)
          sessionId = message.session_id;
        if (message.type === "assistant") {
          const body = message.message as
            | {
                model?: string;
                content?: {
                  type: string;
                  text?: string;
                  name?: string;
                  input?: unknown;
                }[];
              }
            | undefined;
          if (body?.model) reportedModel = body.model;
          for (const block of body?.content ?? [])
            if (block.type === "tool_use")
              note(`${block.name}: ${JSON.stringify(block.input)}`);
          const spoken = (body?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          // Only the closing answer is the session result; earlier turns are work.
          if (spoken.trim()) text = spoken;
        }
        if (message.type === "result") {
          // A provider that cannot honour the schema still answered as text.
          if (
            message.subtype !== "success" &&
            message.subtype !== "error_max_structured_output_retries"
          )
            throw new Error("agent_sdk_failed");
          if (message.structured_output !== undefined)
            structured = message.structured_output;
          if (typeof message.result === "string") text = message.result;
        }
      }
    } catch (error) {
      const safe = redactSecrets(diagnostic);
      throw new Error(
        `agent_sdk_error: ${String(error)}${safe.length ? `; ${safe}` : ""}`,
      );
    }
    return { text, structured, reportedModel, sessionId };
  },
};
