/** Model providers, device accounts and account inspection. */
export const profiles = {
  quota: {
    nativeSnapshot: "Native app observation · may be cached",
    title: "Usage",
    accountScope: "Account quota",
    refresh: "Refresh account usage",
    unknown: "Unknown",
    windowMinutes: "{{minutes}} min",
    extraUsage: "Extra usage",
    offline: "Device offline · last observed usage",
    failed: "Could not refresh · showing last observed usage",
    renewal: "Open the native app to renew its login, then refresh usage.",
    unsupported: "This native version does not expose account usage.",
    unavailable: "Account usage is currently unavailable.",
    stale: "Last observed usage · refresh for current limits",
    more: "Show {{count}} more",
    less: "Show less",
    observed: "Checked {{time}}",
  },
  runtimeUpdates: {
    updateNowLabel: "Update {{name}} to stable",
    noticeTitle: "{{name}} {{version}} → stable {{target}}",
    workerRequired:
      "Update this device’s worker to enable automatic agent updates.",
    externalHint:
      "This copy was installed outside Foundry (a package manager or an app), so Foundry can’t update it. Foundry can install its own copy beside it and keep that one up to date.",
    switchManaged: "Use Foundry-managed copy",
    switchManagedLabel: "Install a Foundry-managed copy of {{name}}",
    waitingHint:
      "The worker will update automatically when active {{name}} work finishes. Other agents can keep running.",
    updatingHint: "The worker is updating and validating the stable version.",
    failedHint:
      "The worker could not complete the update and kept the previous version. You can retry here.",
    automaticHint:
      "The worker checks official stable releases and updates automatically when this agent is idle.",
    updateNow: "Update to stable",

    policy:
      "Agent runtimes follow official stable releases and update when idle.",
    current: "Installed version",
    path: "Executable",
    target: "Latest stable",
    sdk: "SDK target",
    status: "Update status",
    check: "Check for updates",
    checking: "Checking updates…",
    states: {
      unknown: "Not checked",
      checking: "Checking",
      current: "Up to date",
      available: "Update available",
      waiting_idle: "Waiting for active work to finish",
      updating: "Updating and validating",
      failed: "Update failed; previous runtime retained",
      external: "Managed by another installer",
    },
  },

  page: {
    title: "Model providers",
    intro:
      "The model APIs and gateways agents run on, stored on this server. Assign each to the devices that may use it.",
    openDeviceAccounts:
      "Use a ChatGPT or Claude subscription? Open device accounts →",
    requestFailed: "The request failed.",
    saveFailed: "Could not save this change to the server.",
    profileSaved: "{{label}} saved.",
    profileDeleted: "{{label}} deleted.",
    credentialCleared: "Credential cleared for {{label}}.",
    newConnection: "New model provider",
    editConnection: "Edit model provider",
    modalDescription:
      "Configure an API or gateway. Official logins stay on each device.",
    closeEditor: "Close provider editor",
    catalogDevice: "Catalog device",
    catalogDeviceReady:
      "Model discovery runs on this device; it does not change your active workspace.",
    catalogDeviceUnavailable:
      "The catalog device is unavailable. Select an online device, or enter models and save without discovery.",
    chooseOnlineDevice: "Choose an online device",
    saveFirst: "Save this provider first, then assign devices here.",
  },
  list: {
    title: "Providers",
    saved: "{{count}} saved on this server",
    newConnection: "New provider",
    emptyTitle: "Add your first model provider",
    emptyBody:
      "Add a model API or gateway here. Official Claude and Codex accounts are managed on each device.",
    runtimeDefaultModel: "Runtime default model",
  },
  editor: {
    unsaved: "Unsaved",
    noKey: "No key configured",
    newConnection: "New provider",
    kind: "API / gateway",
    updated: "Updated {{time}}",
    name: "Name",
    nameLabel: "Profile name",
    namePlaceholder: "My model provider",
    runtime: "Runtime",
    runtimeLabel: "Profile runtime",
    baseUrl: "Base URL",
    baseUrlLabel: "Profile base URL",
    baseUrlSavedAs: "Will be saved as {{url}}.",
    baseUrlCorrection: {
      scheme_added: "No scheme was typed, so one was added.",
      endpoint_path_removed:
        "The request path was removed; the runtime adds its own.",
      version_removed:
        "/v1 was removed: Claude Code appends /v1/messages itself.",
      version_added: "/v1 was added: Codex calls <base>/responses.",
    },
    baseUrlError: {
      empty: "Enter the provider's base URL.",
      invalid_url: "Enter a URL such as https://gateway.example.com.",
      unsupported_scheme: "The URL must start with https:// or http://.",
      credentials_in_url:
        "Remove the user name or key from the URL; put the key in API key.",
      query_or_fragment: "Remove the ?query or #fragment from the URL.",
    },
    protocolHint:
      "{{runtime}} protocol is selected from the runtime. Provider type does not need separate configuration.",
    apiKey: "API key · Optional",
    apiKeyLabel: "Profile API key",
    apiKeySealed: "Sealed on this server — leave blank to keep it",
    apiKeyKeyless: "Leave blank for a keyless gateway",
    apiKeyHint:
      "Optional. Leave it empty for internal gateways or proxies that authenticate themselves; nothing is sent without a key.",
    clearConfirm: "Clear it for good?",
    clearCredential: "Clear credential",
    model: "Model",
    modelLabel: "Profile model",
    modelRefreshNote:
      "Refresh asks this endpoint for its catalog. Anything you type is kept as an option.",
    modelTypeNote:
      "Type the model you want. Connect a device and enter an endpoint to refresh its catalog.",
    modelHint:
      "Every model here is selectable in chat and issue runs; the checked one is the default.",
    runtimeDefaults: "Runtime defaults",
    saveThenAssign: "Save first, then assign devices below.",
    deleteConfirm: "Delete this provider?",
    delete: "Delete",
    create: "Create provider",
    save: "Save provider",
  },
  codexTransport: {
    title: "Responses transport",
    label: "Codex Responses transport",
    auto: "Auto",
    websocket: "WebSocket",
    https: "HTTPS",
    hint: "Auto lets Codex try the Responses WebSocket itself and remembers what happened for this base URL for 7 days. Saving the provider learns it again.",
    learned: "Transport: {{transport}} (learned {{date}}: {{reason}})",
    chosen: "Transport: {{transport}} (set here)",
    unknown:
      "Transport: not learned yet. The next session tries the WebSocket; Codex falls back to HTTPS if the endpoint refuses it.",
    fellBack: "Codex fell back to HTTPS",
    fellBackDetail: "Codex fell back to HTTPS: {{detail}}",
    streamed: "a turn streamed over the WebSocket",
    cardLearned: "Transport: {{transport}} · learned {{date}}",
    cardChosen: "Transport: {{transport}} · set here",
    cardUnknown: "Transport: learned on the next session",
  },
  contextWindows: {
    title: "Context windows",
    intro:
      "Each model runs with the window you set here. Left blank, it uses the window the endpoint's model list reports, else the official window when the name is a Claude or GPT model, else 1M.",
    noModels: "Add a model above to set its context window.",
    catalogUnread: "The endpoint's own windows have not been read yet.",
    catalogUnavailable:
      "Connect a device to read the endpoint's own windows; until then official and default windows are shown.",
    readCatalog: "Read endpoint windows",
    automatic: "Automatic: {{tokens}} · {{source}}",
    source: {
      setting: "your setting",
      endpoint: "endpoint model list",
      official: "official model",
      default: "default",
    },
    inputLabel: "Context window for {{model}}",
    placeholder: "Automatic",
    invalid: "Enter tokens such as 200000, 200K or 1M (1K to 10M).",
  },
  catalog: {
    asking: "Asking for the catalog…",
    changed: "Provider changed. Refresh again for its current catalog.",
    notAList: "The device did not return a model list.",
    found_one: "{{count}} model from the endpoint.",
    found_other: "{{count}} models from the endpoint.",
    failed: "The catalog read failed.",
  },
  connectionDevices: {
    title: "Device access",
    intro:
      "Choose which devices may use this provider. The key stays sealed on the server and is sent only for execution or an explicit catalog read.",
    noDevices: "Connect a device from Devices to assign this provider.",
    online: "Online",
    offline: "Offline · assignment applies when it reconnects",
    assigned: "Assigned",
    notAssigned: "Not assigned",
    removeConfirm: "Remove {{connection}} from {{device}}?",
    removeLabel: "Remove {{connection}} from {{device}}",
    removeAccess: "Remove access",
    assignLabel: "Assign {{connection}} to {{device}}",
    assign: "Assign",
    updateFailed: "Could not update device access.",
    deviceBound:
      "Runs only on {{device}}: {{address}} is that device's own address, which other devices cannot reach.",
  },
  deviceConnections: {
    title: "Server model providers",
    intro:
      "API keys and model defaults are saved on the server. Grant this device access to use a provider.",
    add: "Add provider",
    savedRefreshing: "Saved · updating the list…",
    saved: "Saved.",
    storedOnServer: "{{detail}} · Stored on server",
    storedOnServerNoKey: "{{detail}} · Stored on server · No key configured",
    assigned: "Assigned",
    removeConfirm: "Remove {{connection}} from {{device}}?",
    removeAccess: "Remove access",
    none: "No model providers assigned. Official device accounts work independently.",
    manage: "Manage model providers →",
    refreshFailed: "Saved, but the list could not be refreshed.",
    refreshFailedDetail:
      "Saved, but the list could not be refreshed: {{error}}",
    retrying: "Retrying…",
    retryRefresh: "Retry refresh",
    saveFailed: "Could not save this change.",
  },
  providers: {
    externalStates: {
      helper_missing: "Helper missing",
      unchecked: "Not checked",
      failed: "Check failed",
      ready: "Ready to use",
    },
    externalMeta: "External connection · model {{model}}",
    externalHelperMissing:
      "Its helper is no longer an executable file on this device. Reinstall or update the gateway; its installer registers the connection again.",
    externalUncheckedHint:
      "Not checked yet. Check it before choosing it in a chat.",
    externalActionsNote:
      "Check sends one short conversation through the connection and uses model quota; it never runs automatically. Remove deletes only that connection from this device; the gateway stays installed.",
    externalFailed: "Last check failed: {{reason}}",
    externalCheck: "Check",
    externalCheckAgain: "Check again",
    externalChecking: "Checking…",
    externalRemove: "Remove",
    externalRemoveConfirm: "Remove from device?",
    externalRemoving: "Removing…",
    externalChecked: "{{name}} answered and can now be chosen in a chat.",
    externalCheckFailed: "{{name}} did not answer.",
    externalRemoved: "{{name}} was removed from {{device}}.",
    externalActionFailed: "The device could not complete this action.",
    externalUpdateWorker:
      "Update this device's worker to check or remove external connections here.",
    externalOwnerOnly:
      "Only this device's owner can check or remove its external connections.",
    externalOffline:
      "Connect this device to check or remove its external connections.",
    externalRegisterHint:
      "External connections are registered by their gateway's installer, which runs {{command}} on this device.",
    title: "Configured on this device",
    intro:
      "Model connections configured on {{device}}. Each was checked by running one short conversation through its agent; ready connections can be chosen in a chat.",
    ready: "Ready to use",
    from: "from {{source}}",
    answered: "checked {{time}}",
    actions: "Actions for {{name}}",
    promote: "Promote to Model providers…",
    updatePromotion: "Update in Model providers…",
    promoted: "Promoted to Model providers",
    openPromoted: "Open {{name}} in Model providers",
    checking: "Checking that {{names}} answers…",
    notAnswering:
      "Not offered: {{name}} does not answer ({{reason}}). If you no longer use it, remove it from {{source}}.",
  },
  promotion: {
    title: "Promote {{name}} to Model providers",
    updateTitle: "Update {{name}} in Model providers",
    description:
      "Copies this provider from {{device}}'s configuration into a Model provider on the server. Chats then use the server copy. {{source}} is not changed.",
    updateDescription:
      "Copies this provider again into the Model provider it was promoted to, instead of adding another. Settings changed there since stay. {{source}} is not changed.",
    copied: "What is copied",
    name: "Name",
    agent: "Agent",
    baseUrl: "Base URL",
    api: "API",
    claudeApi: "Anthropic Messages API",
    codexApi: "OpenAI Responses API",
    defaultModel: "Default model",
    agentDefault: "The agent's default",
    models: "Models",
    key: "API key",
    copyKey: "Also copy the key from {{source}}",
    copyKeyHint:
      "{{device}} reads this one value and the server seals it. It is never shown in the browser.",
    keyKept: "Without it, the key the Model provider already has stays.",
    noKey:
      "This provider's configuration names no API key, so no key is copied.",
    keyOffline: "{{device}} is offline, so its key cannot be read now.",
    devices: "Devices",
    loopback:
      "{{address}} is {{device}}'s own address, which other devices cannot reach, so this Model provider runs only on {{device}}.",
    shareable:
      "It is enabled on {{device}}. You can enable it on other devices in Model providers.",
    promote: "Promote",
    update: "Update",
    promoting: "Promoting…",
    failed: "Could not promote this provider.",
  },
  assignment: {
    title: "Choose model providers",
    description:
      "Checked providers can be used on this device. Changes apply only when you save.",
    empty: "No model providers yet.",
    openConnections: "Open Model providers",
    grant: "Grant {{connection}} on this device",
    selected: "Selected for this device",
    notSelected: "Not selected",
    manage: "Create or edit providers",
    saveFailed: "Could not update this device's model providers. Try again.",
  },
  accounts: {
    suspended: "Suspended",
    suspendedDetail:
      "{{account}} reported an account suspension at {{at}}. Foundry has stopped sending work to this account.",
    resumeHint:
      "After resolving the suspension, you can allow Foundry to try this account again. This does not verify recovery with the provider. Another explicit suspension will block it again.",
    resume: "Resume use",
    resuming: "Resuming…",
    resumeFailed: "Could not resume the account. Refresh and try again.",

    localLoginDetected: "Local login detected · Online validity not checked",
    installNative: "Install the native agent on this device.",
    noLogin:
      "No login in the worker’s configuration · Check other local configurations",
    accountAndDefaults: "Account & defaults",
    deviceOffline: "Device offline",
    localLogin: "Local login",
    cliMissing: "{{name}} is not installed on this device yet.",
    notInstalled: "Not installed",
    unavailable: "Unavailable",
    workerNoLogin: "Worker: no login",
    installCli: "Install {{name}}",
    installCliConfirm: "Run the installer on {{device}}?",
    installCliLabel: "Install {{name}} on {{device}}",
    installCliHint:
      "Foundry installs the official release on {{device}} for this account (no administrator rights needed) and keeps it up to date.",
    runtimeChangeFailed: "{{name}} could not be updated or replaced.",
    installingCli: "Installing {{name}} on {{device}}…",
    installCliDone: "{{name}} is installed on {{device}}. Sign in to use it.",
    installCliFailed: "{{name}} could not be installed on {{device}}.",
    installCliLog: "Installer output",
    cliOutdated:
      "{{name}} {{version}} on {{device}} is older than the {{minimum}} Foundry needs. Update it there: {{command}}",
    checkFailed: "Could not check login.",
    startFailed: "Could not start this on the device.",
    signInHintClaude:
      "Not signed in. On {{device}}, run claude in a terminal and sign in with /login; then check again.",
    signInHintCodex:
      "Not signed in. On {{device}}, run codex login in a terminal; then check again.",
    checkAgain: "Check again",
    checkAgainLabel: "Check the {{name}} login on {{device}} again",
    checking: "Checking…",
    legacyTitle: "Earlier official profile settings ({{count}})",
    legacyIntro:
      "Preserved for existing sessions; these are runtime presets, not separate accounts. New logins use the device accounts above. No historical records have been changed.",
    runtimeDefault: "Runtime default",
    previouslyAssigned: "Previously assigned to this device",
    notAssigned: "Not assigned to this device",
  },
  accountDefaults: {
    contextWindow: "Context window (tokens)",
    contextAutomatic: "Automatic maximum",
    contextChooseModel: "Choose a model to set its context window.",
    contextNativeLimit: "the native CLI limit",
    contextHint:
      "Automatic uses up to {{limit}} tokens. You can request a smaller window (for example, 256K). Codex applies its own cap and reserved space. Changes take effect on the next turn, not during a running turn.",

    sectionLabel: "{{runtime}} runtime defaults",
    codexCatalog:
      "Models from OpenAI’s published Codex catalog and the native CLI. Offline results may be older; availability depends on your account and CLI version.",
    claudeCatalog: "Official options reported by Claude Code on this device.",
    loadFailed: "Could not load official models. Retry.",
    hint: "Defaults for new sessions on {{device}}. Existing sessions are unchanged.",
    defaultModel: "Default model",
    modelLabel: "{{runtime}} official default model",
    nativeDefault: "Native agent default",
    loading: "Loading official models…",
    invalidModel:
      "The saved model is not in this official catalog. Select an official model or use the native default.",
    useNativeDefault: "Use native default",
    saved: "Device defaults saved.",
    saveFailed: "Could not save defaults.",
    save: "Save defaults",
  },
  detected: {
    title: "Daemon-reported profiles",
    intro:
      "Profiles the daemon found in local configuration. Remote endpoints can be promoted into model providers usable from any device.",
    found: "{{count}} found",
    emptyBody:
      "The daemon has not reported any locally configured agent profile.",
    emptyTitle: "Nothing detected",
    signedInAs: "Signed in as {{account}}",
    promoted: "Promoted",
    promotedBody:
      "Already a model provider any device can run. Edit it in Model providers.",
    serverHasCredential:
      "The server already holds this credential. Promoting it needs no key from you.",
    keySealed:
      "The key this machine uses is sealed into the server so any device can run the profile.",
    promoting: "Promoting",
    promote: "Promote",
  },
  inspection: {
    status: {
      verified: "Verified online",
      local_login: "Local login · unverified online",
      not_signed_in: "No login in this configuration",
      unavailable: "Check unavailable",
    },
    recheckLocal: "Re-check local login",
    checkLocal: "Check local login",
    checkAccount: "Check account & usage",
    checkingLocal: "Checking local login…",
    checking: "Checking…",
    sectionLabel: "{{runtime}} account verification",
    title: "Account status",
    offline: "Connect this device to check its native account configuration.",
    retry: "Retry",
    windowDays: "{{days}}-day window",
    windowHours: "{{hours}}h window",
    usageWindow: "Usage window",
    used: "{{percent}}% used",
    limitReached:
      "Limit reached · Login is valid, but this window has no remaining allowance.",
    usageLabel: "Account usage",
    resets: "Resets {{time}}",
    sourceGoneUnavailable:
      "<code>{{source}}</code> is no longer present on this device. It cannot be checked from here.",
    sourceGoneStale:
      "<code>{{source}}</code> is no longer present on this device. The read below is the last stored result, not a fresh online check.",
    inspectAnother: "Inspect another local configuration",
    inspectLabel: "Account configuration to inspect",
    usedByFoundry: "Used by Foundry",
    otherApp: "Other app · inspection only",
    backToFoundry: "Back to Foundry’s configuration",
    foundryUses: "Login source: <code>{{source}}</code>",
    viewingOther:
      " · Viewing another configuration does not change the execution account.",
    lastChecked: "Last checked {{time}} · Credentials stay on this device.",
    configurationUnavailable: "Configuration unavailable",
    fallback:
      "<code>{{source}}</code> is no longer present on this device. The configuration Foundry actually uses is still shown below.",
    asking: "Asking the native agent; no model request is sent.",
    checkFailed:
      "Could not check this account. Reconnect the device and retry.",
  },
};
