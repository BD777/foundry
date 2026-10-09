// A stand-in for the Claude Agent SDK, loaded through fake-steer-sdk-hooks.mjs.
// Its turn stays open, as one busy in a tool does, until a second message is
// steered in; then it answers. It records what each message said and never
// contacts a provider.
export const received = [];

export function query({ prompt }) {
  const input = prompt[Symbol.asyncIterator]();
  const read = async () => {
    const next = await input.next();
    if (!next.done) received.push(next.value.message.content);
    return !next.done;
  };
  return (async function* () {
    if (!(await read())) return;
    yield { type: "system", subtype: "init", session_id: "steer-session" };
    if (!(await read())) return;
    yield {
      type: "assistant",
      session_id: "steer-session",
      message: { model: "fake", content: [{ type: "text", text: "green" }] },
    };
    yield {
      type: "result",
      subtype: "success",
      result: "green",
      session_id: "steer-session",
    };
    while (await read());
  })();
}
