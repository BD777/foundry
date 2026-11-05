// A stand-in for the Claude Agent SDK, loaded through
// fake-question-sdk-hooks.mjs. Like Claude Code, it offers AskUserQuestion
// only when the host answers permission prompts (canUseTool): then it asks
// the question below, waits for canUseTool's answer and answers with what it
// heard; without one it answers in text. It never contacts a provider.
export const received = [];
export const calls = [];
export const question = {
  questions: [
    {
      question: "Which greeting should the README use?",
      header: "Greeting",
      multiSelect: false,
      options: [
        { label: "Hello (Recommended)", description: "Plain English" },
        { label: "Bonjour", description: "French" },
      ],
    },
    {
      question: "Which extras?",
      header: "Extras",
      multiSelect: true,
      options: [
        { label: "Emoji", description: "" },
        { label: "Signature", description: "" },
      ],
    },
  ],
};

export function query({ prompt, options }) {
  const input = prompt[Symbol.asyncIterator]();
  calls.push({ canUseTool: typeof options.canUseTool === "function" });
  const read = async () => {
    const next = await input.next();
    if (!next.done) received.push(next.value.message.content);
    return !next.done;
  };
  const toolUseID = `toolu_${calls.length}`;
  return (async function* () {
    if (!(await read())) return;
    yield { type: "system", subtype: "init", session_id: "question-session" };
    if (!options.canUseTool) {
      yield* answer("No question tool.");
      while (await read());
      return;
    }
    yield {
      type: "assistant",
      session_id: "question-session",
      message: {
        model: "fake",
        content: [
          {
            type: "tool_use",
            id: toolUseID,
            name: "AskUserQuestion",
            input: question,
          },
        ],
      },
    };
    const denied = await options.canUseTool(
      "Bash",
      { command: "git push" },
      {
        toolUseID: "toolu_bash",
        signal: new AbortController().signal,
        title: "Claude wants to run git push",
      },
    );
    calls.at(-1).denied = denied;
    const result = await options.canUseTool("AskUserQuestion", question, {
      toolUseID,
      signal: new AbortController().signal,
    });
    calls.at(-1).result = result;
    yield {
      type: "user",
      session_id: "question-session",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseID, content: "answered" },
        ],
      },
    };
    yield* answer(JSON.stringify(result.updatedInput?.answers ?? null));
    while (await read());
  })();
}

function* answer(text) {
  yield {
    type: "assistant",
    session_id: "question-session",
    message: { model: "fake", content: [{ type: "text", text }] },
  };
  yield {
    type: "result",
    subtype: "success",
    result: text,
    session_id: "question-session",
  };
}
