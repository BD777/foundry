// Stand-ins for the Claude and Codex SDKs, loaded through
// fake-agent-sdk-hooks.mjs. They record what the Session Runtime passes and
// never contact a provider.
import { readdirSync } from "node:fs";

export const calls = [];

export function query({ prompt, options }) {
  return (async function* () {
    const messages = [];
    for await (const message of prompt) messages.push(message);
    calls.push({
      sdk: "claude",
      options,
      // What the session could see when it ran, and what it was told.
      cwdFiles: options.cwd
        ? readdirSync(options.cwd, { recursive: true }).map(String).sort()
        : [],
      promptText: JSON.stringify(messages),
    });
    if (options.model === "wait-for-abort")
      await new Promise((_, reject) =>
        options.abortController.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    yield {
      type: "assistant",
      session_id: "claude-session",
      message: {
        model: "claude-reported",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "a.md" } },
          { type: "text", text: "answer" },
        ],
      },
    };
    yield { type: "result", subtype: "success", result: "answer" };
  })();
}

export class Codex {
  constructor(options) {
    this.options = options;
  }
  startThread(thread) {
    const options = this.options;
    return {
      id: "codex-thread",
      run: async (input, run) => {
        calls.push({ sdk: "codex", options, thread, input, run });
        return {
          finalResponse: "codex answer",
          items: [{ type: "command_execution", command: "ls" }],
        };
      },
    };
  }
}
