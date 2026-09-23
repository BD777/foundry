import type {
  AgentConnectionType,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  ProfileAuthMode,
  ProfileDefinition,
  SaveProfileInput,
} from "@foundry/protocol";

/** Runtimes a server profile can target. `mock` is a test-only daemon runtime. */
export type ProfileRuntime = ProfileDefinition["runtime"];

export interface ProfileDraft {
  /** Write-only. Blank means "keep whatever the server already sealed". */
  authMode: ProfileAuthMode;
  apiKey: string;
  baseUrl: string;
  claudeEffort: ClaudeEffort;
  claudePermissionMode: ClaudePermissionMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexReasoningEffort: CodexReasoningEffort;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  id?: string;
  label: string;
  model: string;
  /** Selectable models for this profile; `model` is the default. */
  models: string[];
  promptPrefix: string;
  runtime: ProfileRuntime;
}

/** Selection key for the unsaved "New profile" draft. */
export const newProfileKey = "__new_profile__";

export const runtimeOptions: Array<{ label: string; value: ProfileRuntime }> = [
  { label: "Codex", value: "codex" },
  { label: "Claude", value: "claude" },
];

export function profileConnectionType(
  runtime: ProfileRuntime,
  authMode: ProfileAuthMode,
): AgentConnectionType {
  if (authMode === "official") return "local_login";
  return runtime === "claude" ? "anthropic_compatible" : "openai_compatible";
}

export function defaultProfileLabel(runtime: ProfileRuntime): string {
  return runtime === "codex" ? "Codex Provider" : "Claude Provider";
}

export function connectionLabel(connectionType: AgentConnectionType): string {
  const labels: Record<AgentConnectionType, string> = {
    anthropic_compatible: "Anthropic compatible",
    custom_command: "Custom command",
    env: "Environment",
    local_login: "Local login",
    openai_compatible: "OpenAI compatible",
  };

  return labels[connectionType];
}

export function defaultProfileDraft(
  runtime: ProfileRuntime = "codex",
): ProfileDraft {
  return {
    authMode: "custom",
    apiKey: "",
    baseUrl: "",
    claudeEffort: "high",
    claudePermissionMode: "acceptEdits",
    codexApprovalPolicy: "never",
    codexReasoningEffort: "high",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    label: defaultProfileLabel(runtime),
    model: "",
    models: [],
    promptPrefix: "",
    runtime,
  };
}

export function draftFromProfile(profile?: ProfileDefinition): ProfileDraft {
  if (!profile) {
    return defaultProfileDraft();
  }

  return {
    ...defaultProfileDraft(profile.runtime),
    authMode:
      profile.authMode ??
      (profile.connectionType === "local_login" ? "official" : "custom"),
    baseUrl: profile.baseUrl ?? "",
    claudeEffort: profile.claudeEffort ?? "high",
    claudePermissionMode:
      profile.claudePermissionMode && profile.claudePermissionMode !== "default"
        ? profile.claudePermissionMode
        : "acceptEdits",
    codexApprovalPolicy: profile.codexApprovalPolicy ?? "never",
    codexReasoningEffort: profile.codexReasoningEffort ?? "high",
    codexSandboxMode: profile.codexSandboxMode ?? "workspace-write",
    codexSpeed: profile.codexSpeed ?? "standard",
    id: profile.id,
    label: profile.label || defaultProfileLabel(profile.runtime),
    model: profile.model ?? "",
    // A profile saved before the list existed still has its default model, and
    // that model is exactly what its list should start as.
    models: profile.models?.length
      ? profile.models
      : profile.model
        ? [profile.model]
        : [],
    /* Kept so a saved value survives a round trip, but nothing injects it any
       more and no field offers it. */
    promptPrefix: profile.promptPrefix ?? "",
  };
}

/** Rewrites runtime-specific knobs when the editor switches runtime. */
export function draftForRuntime(
  draft: ProfileDraft,
  runtime: ProfileRuntime,
): ProfileDraft {
  const defaults = defaultProfileDraft(runtime);
  const labelIsDefault =
    draft.label.trim() === "" ||
    draft.label === defaultProfileLabel(draft.runtime);

  return {
    ...draft,
    claudeEffort:
      runtime === "claude" ? draft.claudeEffort : defaults.claudeEffort,
    claudePermissionMode:
      runtime === "claude"
        ? draft.claudePermissionMode
        : defaults.claudePermissionMode,
    codexApprovalPolicy:
      runtime === "codex"
        ? draft.codexApprovalPolicy
        : defaults.codexApprovalPolicy,
    codexReasoningEffort:
      runtime === "codex"
        ? draft.codexReasoningEffort
        : defaults.codexReasoningEffort,
    codexSandboxMode:
      runtime === "codex" ? draft.codexSandboxMode : defaults.codexSandboxMode,
    codexSpeed: runtime === "codex" ? draft.codexSpeed : defaults.codexSpeed,
    label: labelIsDefault ? defaults.label : draft.label,
    promptPrefix:
      runtime === "claude"
        ? draft.promptPrefix || defaults.promptPrefix
        : defaults.promptPrefix,
    runtime,
  };
}

/**
 * Switching authentication keeps every field. The save payload already decides
 * what each mode sends, so nothing has to be destroyed here — a mis-click on
 * the segmented control must not cost the endpoint and key just typed.
 */
export function draftForAuthMode(
  draft: ProfileDraft,
  authMode: ProfileAuthMode,
): ProfileDraft {
  return { ...draft, authMode };
}

/**
 * Builds the save payload. `apiKey` is omitted when the field is blank so the
 * server keeps the credential it already sealed.
 */
export function buildSaveProfileInput(draft: ProfileDraft): SaveProfileInput {
  const apiKey = draft.apiKey.trim();

  return {
    apiKey: draft.authMode === "custom" ? apiKey || undefined : undefined,
    authMode: draft.authMode,
    baseUrl:
      draft.authMode === "custom"
        ? draft.baseUrl.trim() || undefined
        : undefined,
    claudeEffort: draft.runtime === "claude" ? draft.claudeEffort : undefined,
    claudePermissionMode:
      draft.runtime === "claude" ? draft.claudePermissionMode : undefined,
    codexApprovalPolicy:
      draft.runtime === "codex" ? draft.codexApprovalPolicy : undefined,
    codexReasoningEffort:
      draft.runtime === "codex" ? draft.codexReasoningEffort : undefined,
    codexSandboxMode:
      draft.runtime === "codex" ? draft.codexSandboxMode : undefined,
    codexSpeed: draft.runtime === "codex" ? draft.codexSpeed : undefined,
    connectionType: profileConnectionType(draft.runtime, draft.authMode),
    id: draft.id,
    label: draft.label.trim(),
    model: draft.model.trim() || undefined,
    models: draft.models,
    promptPrefix:
      draft.runtime === "claude"
        ? draft.promptPrefix.trim() || undefined
        : undefined,
    runtime: draft.runtime,
  };
}
