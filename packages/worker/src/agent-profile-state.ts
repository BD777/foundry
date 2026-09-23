import type {
  AgentConnectionType,
  AgentProfileProjection,
  ProviderHealth,
} from "@foundry/protocol";

interface ProjectedProfileStateInput {
  baseUrl?: string;
  command?: string;
  connectionType?: AgentConnectionType;
  hasAuth: boolean;
  localHealth?: ProviderHealth;
}

export function projectedProfileAuthMode({
  connectionType,
  hasAuth,
  localHealth,
}: ProjectedProfileStateInput): AgentProfileProjection["authMode"] {
  if (connectionType === "local_login") {
    return localHealth?.authMode ?? "missing";
  }
  if (connectionType === "custom_command") {
    return "local_config";
  }
  return hasAuth ? "local_config" : "missing";
}

export function projectedProfileStatusDetail({
  baseUrl,
  command,
  connectionType,
  hasAuth,
  localHealth,
}: ProjectedProfileStateInput): string | undefined {
  if (connectionType === "local_login") {
    return localHealth?.statusDetail;
  }
  if (connectionType === "custom_command") {
    return command?.trim()
      ? undefined
      : "Command profile has no command configured.";
  }
  if (!hasAuth) {
    return "No local secret or matching environment variable is configured.";
  }
  if (
    (connectionType === "anthropic_compatible" ||
      connectionType === "openai_compatible") &&
    !baseUrl?.trim()
  ) {
    return "Provider base URL is empty.";
  }
  return undefined;
}
