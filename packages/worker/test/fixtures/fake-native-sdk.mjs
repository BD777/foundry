// Stand-ins for the SDKs as the workspace runners drive them, loaded through
// fake-native-sdk-hooks.mjs: a long-lived Claude query answers each message
// pushed into it; Codex threads start or resume. They record what the runner
// asked for and never contact a provider.
export const calls = [];
/** Native sessions the fake Claude refuses to resume. */
export const refused = new Set();
let fresh = 0;

export function query({ prompt, options }) {
  const call = { sdk: "claude", options, prompts: [] };
  calls.push(call);
  const session = options.forkSession
    ? options.sessionId
    : (options.resume ?? `fresh-${++fresh}`);
  return (async function* () {
    for await (const message of prompt) {
      call.prompts.push(message.message.content);
      if (refused.has(options.resume)) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`No conversation found with session ID: ${options.resume}`],
          session_id: session,
        };
        continue;
      }
      yield { type: "system", subtype: "init", session_id: session };
      yield {
        type: "assistant",
        session_id: session,
        message: { model: "fake", content: [{ type: "text", text: "answer" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "answer",
        session_id: session,
      };
    }
    call.closed = true;
  })();
}

export class Codex {
  constructor(options) {
    this.options = options;
  }
  startThread(thread) {
    return this.thread("start", undefined, thread);
  }
  resumeThread(id, thread) {
    return this.thread("resume", id, thread);
  }
  thread(kind, id, thread) {
    const options = this.options;
    return {
      id: id ?? `codex-fresh-${++fresh}`,
      run: async (input) => {
        calls.push({ sdk: "codex", kind, id, input, thread, options });
        return { finalResponse: "codex answer", items: [] };
      },
    };
  }
}
