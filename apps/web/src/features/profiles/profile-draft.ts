import {
  parseContextWindow,
  type AgentConnectionType,
  type ClaudeEffort,
  type ClaudePermissionMode,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CodexSpeed,
  type ProfileAuthMode,
  type ProfileDefinition,
  type SaveProfileInput,
} from "@bd777/foundry-protocol";

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
  /** The person's window per model, as typed (`200k`, `1M`); blank is automatic. */
  contextWindows: Record<string, string>;
  promptPrefix: string;
  runtime: ProfileRuntime;
}

/** Selection key for the unsaved "New profile" draft. */
export const newProfileKey = "__new_profile__";

export const runtimeOptions: Array<{ label: string; value: ProfileRuntime }> = [
  // i18n-ignore: runtime product name
  { label: "Codex", value: "codex" },
  // i18n-ignore: runtime product name
  { label: "Claude", value: "claude" },
];

export function profileConnectionType(
  runtime: ProfileRuntime,
  authMode: ProfileAuthMode,
): AgentConnectionType {
  if (authMode === "official") return "local_login";
  return runtime === "claude" ? "anthropic_compatible" : "openai_compatible";
}

/** Default name saved with a new connection; data, so not translated. */
export function defaultProfileLabel(runtime: ProfileRuntime): string {
  // i18n-ignore: saved as the connection's name and compared on runtime switch
  return runtime === "codex" ? "Codex Provider" : "Claude Provider";
}

export function defaultProfileDraft(
  runtime: ProfileRuntime = "codex",
): ProfileDraft {
  return {
    authMode: "custom",
    apiKey: "",
    baseUrl: "",
    claudeEffort: "high",
    claudePermissionMode: "bypassPermissions",
    codexApprovalPolicy: "never",
    codexReasoningEffort: "high",
    codexSandboxMode: "danger-full-access",
    codexSpeed: "standard",
    label: defaultProfileLabel(runtime),
    model: "",
    models: [],
    contextWindows: {},
    promptPrefix: "",
    runtime,
  };
}

/** A stored window as the field shows it: `1M`, `200K`, or the plain count. */
export function contextWindowText(tokens: number): string {
  // i18n-ignore: token units, read back by parseContextWindow
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  // i18n-ignore: token units, read back by parseContextWindow
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

/** Models whose typed window is not a window. */
export function invalidContextWindows(draft: ProfileDraft): string[] {
  return draft.models.filter((model) => {
    const text = draft.contextWindows[model]?.trim();
    return !!text && parseContextWindow(text) === undefined;
  });
}

function contextWindowsInput(draft: ProfileDraft): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const model of draft.models) {
    const tokens = parseContextWindow(draft.contextWindows[model] ?? "");
    if (tokens !== undefined) windows[model] = tokens;
  }
  return windows;
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
        : "bypassPermissions",
    codexApprovalPolicy: profile.codexApprovalPolicy ?? "never",
    codexReasoningEffort: profile.codexReasoningEffort ?? "high",
    codexSandboxMode: profile.codexSandboxMode ?? "danger-full-access",
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
    contextWindows: Object.fromEntries(
      Object.entries(profile.contextWindows ?? {}).map(([model, tokens]) => [
        model,
        contextWindowText(tokens),
      ]),
    ),
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
    contextWindows:
      draft.authMode === "custom" ? contextWindowsInput(draft) : undefined,
    promptPrefix:
      draft.runtime === "claude"
        ? draft.promptPrefix.trim() || undefined
        : undefined,
    runtime: draft.runtime,
  };
}
