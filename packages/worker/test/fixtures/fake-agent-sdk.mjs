// Stand-ins for the Claude and Codex SDKs, loaded through
// fake-agent-sdk-hooks.mjs. They record what the Session Runtime passes and
// never contact a provider.
export const calls = [];

export function query({ prompt, options }) {
  return (async function* () {
    for await (const _ of prompt);
    calls.push({ sdk: "claude", options });
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
