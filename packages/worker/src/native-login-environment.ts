/** Pin official account operations without disabling project instructions. */
export function nativeLoginEnvironment(
  runtime: "claude" | "codex",
): Record<string, string> {
  if (runtime === "claude") {
    return {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_CUSTOM_HEADERS: "",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      FOUNDRY_AGENT_MODEL: "",
      ANTHROPIC_MODEL: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
      CLAUDE_CODE_SUBAGENT_MODEL: "",
    };
  }
  return {
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_API_BASE: "https://api.openai.com/v1",
    CODEX_BASE_URL: "https://api.openai.com/v1",
    FOUNDRY_AGENT_MODEL: "",
    OPENAI_MODEL: "",
    CODEX_MODEL: "",
  };
}
