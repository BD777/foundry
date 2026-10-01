/** Agents and their runtime settings: effort, permissions, models, status. */
export const agents = {
  effort: {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  },
  claudePermission: {
    acceptEdits: "Accept edits",
    auto: "Auto",
    bypassPermissions: "Bypass permissions",
    dontAsk: "Don't ask",
    plan: "Plan",
  },
  claudePermissionSummary: {
    acceptEdits:
      "Allow edits; sensitive actions still follow Claude Code rules",
    auto: "Let Claude Code choose how to handle permissions",
    bypassPermissions: "Skip Claude Code permission prompts",
    dontAsk: "Stop asking for permission",
    plan: "Plan first; make no changes directly",
  },
  codexSandbox: {
    "read-only": "Read only",
    "workspace-write": "Workspace write",
    "danger-full-access": "Danger full access",
  },
  codexSandboxSummary: {
    "read-only": "Read-only access",
    "workspace-write": "Can write in the current workspace",
    "danger-full-access": "Full access to this machine",
  },
  codexApproval: {
    untrusted: "Untrusted",
    "on-request": "On request",
    "on-failure": "On failure",
    never: "Never",
  },
  codexApprovalSummary: {
    untrusted: "Untrusted mode",
    "on-request": "Confirm when the agent asks",
    "on-failure": "Ask for permission after a failure",
    never: "Never ask for confirmation",
  },
  codexSpeed: {
    standard: "Standard",
    fast: "Fast",
  },
  codexSpeedSummary: {
    standard: "Normal speed",
    fast: "1.5× speed, uses more quota",
  },
  controls: {
    permissions: "Permissions",
    permissionsTrigger: "Permissions: {{label}}",
    claudePermission: "Claude Code permission",
    codexPermissions: "Codex permissions",
    sandbox: "Sandbox",
    approval: "Approval",
    modelAndEffort: "Model and effort",
    modelAndEffortTrigger: "Model and effort: {{model}} · {{effort}}",
    model: "Model",
    effort: "Effort",
    speed: "Speed",
    resetToProfile: "Reset to connection defaults",
    modelRefreshFailed: "Couldn't refresh the model list",
    modelRefreshFailedKept:
      "Couldn't refresh the model list; the connection's configured models are kept",
    retryRefresh: "Retry refresh",
    loadingModels: "Loading models",
    modelsUnavailable: "Models unavailable",
    noModels: "No models",
  },
  defaults: {
    claudeEffort: "Claude effort",
    claudePermission: "Claude permission",
    codexEffort: "Codex reasoning effort",
    codexSandbox: "Codex sandbox",
    codexApproval: "Codex approval",
    codexSpeed: "Codex speed",
    foundryDefault: "Foundry default",
  },
  composer: {
    agent: "Agent",
    attachContext: "Attach context",
    noAgent: "No agent",
    manageDeviceAccounts: "Manage device accounts…",
  },
  modelCombobox: {
    selectModel: "Select a model",
    filterOrType: "Filter or type a model",
    searchOfficial: "Search official models",
    refreshFromEndpoint: "Refresh models from the endpoint",
    refreshOfficial: "Refresh official models",
    loading: "Loading models…",
    noMatch: "No matching model.",
    remove: "Remove {{model}}",
    use: "Use “{{model}}”",
  },
  picker: {
    deviceAccount: "{{runtime}} · Device account",
    deviceOffline: "Device is offline.",
    unavailableOnDevice: "Unavailable on this device.",
    notEnabledOnDevice: "Not enabled on a device yet.",
    noCredential: "No credential stored for this profile.",
    workerNotSignedIn: "Worker configuration is not signed in.",
    noSignIn: "No sign-in or credential on this device.",
    unavailable: "Unavailable.",
  },
  profileStatus: {
    notEnabledAnywhere:
      "Not enabled on any device yet. Choose the devices that may run it on the Device page.",
    deviceOffline: "Device is offline.",
    runtimeUnavailable: "Runtime is unavailable on this device.",
    authorizeOnDevice: "Authorize this profile on the device.",
    notEnabled: "Not enabled",
    secrets: {
      none: "None stored",
      server: "Server",
      local: "Local",
      mixed: "Mixed",
    },
    connectionType: {
      anthropic_compatible: "Anthropic-compatible",
      custom_command: "Custom command",
      env: "Environment",
      local_login: "Local login",
      openai_compatible: "OpenAI-compatible",
    },
    promotionBlock: {
      notSignedIn:
        "Not signed in yet. Official logins are per machine and never move to the server.",
      signedIn:
        "Signed in on this machine. Official logins are per machine and never move to the server.",
      env: "Backed by an environment variable that only exists on this machine.",
      customCommand: "Runs a local command that only exists on this machine.",
    },
    provider: {
      healthy: "Configured",
      missing_auth: "Needs auth",
      unavailable: "Unavailable",
    },
    authMode: {
      env: "Environment",
      local_config: "Local config",
      missing: "Not configured",
    },
  },
  connections: {
    keyConfigured: "Configured",
    noKey: "No key configured",
    devices_one: "{{key}} · {{count}} device",
    devices_other: "{{key}} · {{count}} devices",
    notAssigned: "{{key}} · Not assigned",
  },
  diagnostics: {
    submodulesBlocked_one:
      "Workspace initialization was blocked by {{count}} uninitialized submodule. Inspect Environment for the affected repositories.",
    submodulesBlocked_other:
      "Workspace initialization was blocked by {{count}} uninitialized submodules. Inspect Environment for the affected repositories.",
    discoveryBlocked:
      "Workspace initialization was blocked by repository discovery problems. Inspect the Environment repository list for the affected paths.",
  },
};
