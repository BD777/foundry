const fake = new URL("./fake-native-sdk.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (
    specifier === "@anthropic-ai/claude-agent-sdk" ||
    specifier === "@openai/codex-sdk"
  )
    return { url: fake, shortCircuit: true };
  return next(specifier, context);
}
