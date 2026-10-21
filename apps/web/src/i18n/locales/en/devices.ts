/** Devices: the list, adding, settings, access, resources and removal. */
export const devices = {
  list: {
    title: "Devices",
    intro:
      "Choose a device to browse its workspaces, manage agent logins, or configure execution.",
    add: "Add device",
    refresh: "Refresh status",
    refreshing: "Refreshing…",
    workspaceCount_one: "{{count}} workspace",
    workspaceCount_other: "{{count}} workspaces",
    view: "View →",
    sharedWithYou: "Shared with you",
    actionsFor: "Actions for {{device}}",
    removeFromFoundry: "Remove from Foundry…",
    emptyTitle: "No devices connected",
    emptyBody:
      "Use Add device to pair a Foundry worker with this server. It will appear here, along with its registered workspaces.",
  },
  status: {
    online: "Online",
    offline: "Offline",
  },
  detail: {
    notFoundTitle: "Device not found",
    notFoundBody:
      "This device is no longer registered. Your active workspace has not changed.",
    backToDevices: "Back to devices",
    allDevices: "All devices",
    ownedNote:
      "Device settings · Viewing this device does not switch your workspace.",
    sharedNote:
      "Shared device · Viewing this device does not switch your workspace.",
    offline:
      "This device is offline. Saved workspaces and history remain available; sign-in and execution require reconnection.",
    sections: "Device sections",
    workspacesLink_one: "{{count}} workspace",
    workspacesLink_other: "{{count}} workspaces",
    sectionResources: "Resources",
    sectionAgents: "Models & accounts",
    sectionSkills: "Skills",
    sectionSettings: "Settings",
    sectionDiagnostics: "Diagnostics",
    sharedTitle: "Shared with you",
    sharedBody:
      "You reach this device through its workspaces. Models, accounts, skills and settings are managed by the account that paired it.",
  },
  rename: {
    action: "Rename",
    title: "Rename device",
    description:
      "The name everyone sharing this device sees. Its hostname, {{hostname}}, stays in its details.",
    label: "Device name",
    submit: "Save name",
    failed: "Could not rename the device.",
  },
  accountShare: {
    detailsFor: "Shared computer account on {{device}}",
    unreadFor: "Unread shared account notice on {{device}}",
    acceptedOn: "Sharing was accepted on {{date}}.",
    read: "Notice read. The computer account is still shared.",
    refreshFailed:
      "The notice was read, but the device could not be refreshed.",
    label: "Shares a system account with {{names}}",
    body_one:
      "{{names}} uses this computer account too: you work with the same files and the same Claude/Codex sign-ins here; Foundry does not keep your work apart.",
    body_other:
      "{{names}} use this computer account too: you work with the same files and the same Claude/Codex sign-ins here; Foundry does not keep your work apart.",
    chosen: "Since {{date}}, chosen by {{acceptedBy}}.",
    noticed_one:
      "Foundry noticed this computer account is used by both of you.",
    noticed_other:
      "Foundry noticed this computer account is used by all of you.",
    noticeTitle: "Someone else now uses this computer account",
    notice_one:
      "{{names}} now also uses the system account of {{device}} in Foundry: you share its files and Claude/Codex sign-ins.",
    notice_other:
      "{{names}} now also use the system account of {{device}} in Foundry: you share its files and Claude/Codex sign-ins.",
    dismiss: "Got it",
    dismissing: "Saving…",
    dismissFailed: "Could not save that you read this notice.",
  },
  details: {
    missing:
      "This device's worker is older than 0.5.7 and reports no system details; update it to see them.",
    hostname: "Hostname",
    system: "System",
    kernel: "Kernel",
    cpu: "Processor",
    cpuValue: "{{model}} · {{count}} cores · {{arch}}",
    memory: "Memory",
    user: "User",
    worker: "Worker",
    node: "Node.js",
  },
  worker: {
    title: "Worker",
    behindTitle: "This device's worker is behind this server",
    running: "Runs worker {{version}}.",
    unknownVersion: "older than 0.5.7",
    serverBuild: "This server serves {{version}}.",
    serverNpm: "This server uses the npm release.",
    runLocal: "Run on {{device}} to update it and restart the worker:",
    runOnce:
      "Run once on {{device}}; it finds the worker paired with this server and updates it. Afterwards the device has its own update command.",
    updateNow: "Update now",
    updateAgain: "Try the update again",
    updateStalledTitle: "Update did not finish",
    updateStalled:
      "The update started at {{time}} did not finish: the device still runs its old worker.",
    updateStalledLog:
      "The update started at {{time}} did not finish: the device still runs its old worker. Its log on the device: {{log}}",
    updating: "Updating…",
    updateStarted:
      "The device is updating its worker and will restart it; this page shows the new version when it reconnects.",
    updateRunningSince:
      "Updating since {{time}}; the worker restarts with the new version and this page shows it when it reconnects.",
    updateSlow:
      "The device has not come back with the new version yet. Check it under Settings → Worker, or its log.",
    updateFailed: "Could not start the update.",
    updateAll_one: "Update {{count}} worker",
    updateAll_other: "Update {{count}} workers",
    updateAllStarted_one:
      "Updating {{count}} device; each restarts its worker and shows the new version when it reconnects.",
    updateAllStarted_other:
      "Updating {{count}} devices; each restarts its worker and shows the new version when it reconnects.",
    updateAllRunning:
      "Workers are updating; this list refreshes until they reconnect.",
    updateAllManual:
      "Not updatable from here (offline or an older worker): {{devices}}. Open the device for its update command.",
    updateAllFailure: "{{device}}: {{error}}",
    stateUpdatable: "Update available",
    stateManual: "Worker behind",
    stateUpdating: "Updating worker…",
    stateStalled: "Update did not finish",
    stateFailed: "Update failed",
    steps: {
      starting: "Starting the update",
      checking: "Asking the server which worker to install",
      downloading: "Downloading the new worker",
      downloadingVersion: "Downloading {{version}}",
      installing: "Installing",
      installingVersion: "Installing {{version}}",
      restarting: "Restarting the worker",
      waiting: "Waiting for legacy executions to finish",
    },
    stepRunning: "{{step}}…",
    updateStepSince:
      "{{step}}… Started at {{time}}; the worker restarts with the new version and this page shows it when it reconnects.",
    updateWaiting: "Waiting: {{detail}}",
    updateFailedTitle: "Update failed",
    updateFailedReason: "Reason: {{reason}}",
    failedVanished: "the update process ended without reporting.",
    failedNotBack: "the worker did not come back after updating.",
    updateLastStep: "Last step: {{step}}.",
    updateExitCode: "Exit status {{code}}.",
    updateLogTail: "End of the update's log",
    updateLogTailAt: "End of the update's log ({{log}} on the device)",
    sourceCheckout: "It runs from a source checkout, which updates with git.",
  },
  settings: {
    title: "Execution settings",
    intro: "Shared by every workspace on {{device}}.",
    maxTasks: "Maximum concurrent tasks",
    runtimeCache: "Active runtime cache (minutes)",
    runtimeCacheLabel: "Runtime cache minutes",
    saved: "Settings saved.",
    saveFailed: "Could not save settings.",
    save: "Save settings",
    removeTitle: "Remove device",
    removeBody:
      "Unregister {{device}} from this Foundry server. Its workspaces leave the available lists; chats, issues and run history are kept. Nothing on the machine is deleted.",
  },
  add: {
    dialogTitle: "Add or repair a device",
    dialogIntro:
      "Pair a new machine with one command, or check and update a device that is already set up.",
    title: "Add a new device",
    intro:
      "Run one command in a terminal on the machine that should do the work (macOS or Linux with Node.js 20 or later). It installs the worker, pairs it with your account and starts it at login.",
    tokenNote:
      "The token works once and expires at {{time}}. The device starts without a workspace: once it is online, add the folders you want from the Workspaces page, or add <code>{{flag}}</code> to register one now.",
    mirrorNote:
      "If npm uses a private mirror that cannot be reached, add <code>{{flag}}</code> to the command.",
    repairTitle: "Check or repair a device already set up",
    repairIntro:
      "Run on that machine. The first command checks it without downloading anything; the second updates the worker and restarts it.",
    repairLegacy:
      "A device set up with an earlier version gets this command after running <code>{{update}}</code> once.",
    repairServerBuild:
      "This server serves its own worker build ({{version}}), and the update above follows it. A device on the npm release, or set up with an earlier version, switches to it by running this once:",
    copyCommand: "Copy command",
    newToken: "New token",
    creating: "Creating…",
    create: "Create pairing command",
    failedTitle: "Could not create a pairing token",
    consent: {
      title: "This computer account is already in use",
      body_one:
        "This computer account is already used by {{names}} in Foundry. If you continue, you share it: you'll both work with the same files and the same Claude/Codex sign-ins on this account; nothing here keeps your work apart. To have your own separate space, create a separate system account on this computer.",
      body_other:
        "This computer account is already used by {{names}} in Foundry. If you continue, you share it: you'll all work with the same files and the same Claude/Codex sign-ins on this account; nothing here keeps your work apart. To have your own separate space, create a separate system account on this computer.",
      continue: "Continue",
      continuing: "Continuing…",
      cancel: "Cancel",
      cancelling: "Cancelling…",
      failed: "Could not record your choice",
      acceptedTitle: "You chose to share this computer account",
      accepted:
        "The computer finishes pairing on its own. Both devices will then show that they share this system account.",
      cancelledTitle: "Pairing cancelled",
      cancelled:
        "This pairing was cancelled. To pair the computer, create a new pairing command.",
      expiredTitle: "Pairing command expired",
      expired:
        "This token can no longer be used. Create a new pairing command.",
      pairedTitle: "Device paired",
      paired: "The computer is paired and now appears in your devices.",
    },
  },
  removal: {
    title: "Remove device from Foundry?",
    description:
      "This unregisters the device on this Foundry server. It cannot be undone from the list, but nothing on the machine itself is deleted.",
    failed: "Could not remove this device.",
    notFound: "This device is no longer registered. Refresh the list.",
    workspaces_one:
      "{{count}} workspace on this device leaves the device and workspace lists. Chats, issues and run history are kept and still shown where the device is marked removed.",
    workspaces_other:
      "{{count}} workspaces on this device leave the device and workspace lists. Chats, issues and run history are kept and still shown where the device is marked removed.",
    localKept:
      "Local folders and repositories, Claude/Codex sign-ins, provider keys stored on the machine, and worker settings are not deleted.",
    connectionsKept:
      "Model providers and their sealed keys stay available for every other device; only this device's access is revoked.",
    online:
      "The worker is online. It will be disconnected now, will not reconnect, and must be set up again on this machine to return.",
    offline:
      "The device is offline. It will be refused if it contacts this server again; set it up again on the machine to bring it back.",
    blocked:
      "This device owns your current working location. Switch to a workspace on another device before removing it.",
    removing: "Removing…",
    remove: "Remove device",
  },
  access: {
    title: "How this device connects to AI",
    intro:
      "Choose an account or model provider when starting a chat. Both run on <strong>{{device}}</strong>.",
    sources: "AI access sources",
    accountsTitle: "Official accounts",
    accountsHint: "Sign in separately on this device",
    connectionsTitle: "Model providers <em>{{total}}</em>",
    connectionsHint: "From the server or this device's own configuration",
    accountsExplanation:
      "Use your ChatGPT or Claude subscription. Credentials stay on this device; no model provider is needed.",
  },
  resources: {
    title: "Resources",
    intro:
      "Software on {{device}} that sessions may use, detected by its worker when it connects. Foundry never installs resources.",
    kinds: {
      browser: "Browser",
      computer_use: "Screen control",
    },
    detected: "Resources detected again.",
    settingsOpen:
      "System Settings is open on {{device}} ({{panes}}). Turn on the Foundry worker there, then choose Detect again.",
    promptsShown:
      "{{device}} showed its permission prompts. Allow them there, then choose Detect again.",
    granted: "Access is granted.",
    unreachable: "Could not reach the device.",
    detecting: "Detecting…",
    detectAgain: "Detect again",
    emptyTitle: "No resources reported",
    emptyOnline:
      "The worker found no browser or screen control on this device.",
    emptyOffline:
      "The device has not reported its resources; they appear after its worker connects.",
    listLabel: "Device resources",
    available: "Available",
    unavailable: "Not available",
    screenAccess:
      "To let sessions capture and control this Mac, allow the program running the Foundry worker under Screen Recording and Accessibility. The prompts and System Settings open on {{device}}.",
    screenAccessGrantTo:
      "To let sessions capture and control this Mac, allow the program running the Foundry worker (<code>{{grantTo}}</code>) under Screen Recording and Accessibility. The prompts and System Settings open on {{device}}.",
    asking: "Asking the device…",
    openSettings: "Open System Settings…",
    summary: {
      label: "Resource inventory of {{device}}",
      count_one: "{{count}} resource",
      count_other: "{{count}} resources",
      unready_one: "{{count}} not ready",
      unready_other: "{{count}} not ready",
      stale_one: "{{count}} stale",
      stale_other: "{{count}} stale",
      open: "Open in Resources",
      remoteOn: "Remote commands: on",
      remoteOff: "Remote commands: off",
      manageRemote: "Manage",
      manageRemoteLabel: "Manage remote commands of {{device}}",
      loading: "Reading the resource inventory…",
      failed: "Could not read the resource inventory.",
    },
  },
  diagnostics: {
    report: {
      heading: "Diagnostics for {{device}} · worker {{version}} · {{at}}",
      connections: "Recent connections:",
      log: "Worker log:",
    },
    title: "Diagnostics",
    intro:
      "Ask this device's worker for a report on itself: its connection to the server, its runtime, its agents and the end of its log (secrets removed). It makes no model requests.",
    run: "Run diagnostics",
    running: "Running…",
    runningNote: "The worker is checking itself; this takes up to a minute.",
    copy: "Copy report",
    offline: "The device is offline; diagnostics run once it reconnects.",
    lastDisconnect: "Last disconnect: {{line}}",
    noDisconnect: "No disconnect recorded since the server started.",
    generated: "Worker {{version}} · {{at}}",
    log_one: "Worker log ({{count}} line, secrets removed)",
    log_other: "Worker log ({{count}} lines, secrets removed)",
    status: { ok: "OK", info: "Info", warn: "Attention", error: "Problem" },
    group: {
      connection: "Connection",
      runtime: "Worker",
      agents: "Agents",
      workspaces: "Workspaces",
      skills: "Skills",
      chats: "Local chats",
    },
    check: {
      server: "Server reachable",
      socket: "Live connection round trip",
      drops: "Drops in the last 30 minutes",
      proxy: "Proxy",
      eventLoop: "Worker responsiveness",
      memory: "Memory",
      disk: "Disk space",
      workspaces: "Registered folders",
      skills: "Skill scan",
      chats: "Local chat sync",
    },
    ms: "{{ms}} ms",
    server: {
      answered: "{{url}} answered in {{ms}} ms (HTTP {{status}})",
      failed: "{{url}} did not answer: {{error}}",
      adviceFailed:
        "This device cannot reach the server. Check its network, VPN or proxy.",
      adviceSlow:
        "The server answers slowly from here; check the network between this device and the server.",
    },
    socket: {
      advice:
        "The live connection did not answer in time. If drops keep happening, the network or a proxy may be cutting idle connections.",
    },
    drops: {
      none: "None",
      some_one: "{{count}} drop · last: {{last}}",
      some_other: "{{count}} drops · last: {{last}}",
      adviceSilent:
        "Data from the server stopped arriving before {{silentServer}} of them, so the worker reconnected. A network device or proxy between this device and the server is likely dropping the connection; try another network or ask your network admin.",
      advice:
        "The connection keeps dropping. Run diagnostics again after the next drop and copy the report.",
    },
    proxy: {
      none: "No proxy set",
      set: "proxy {{proxy}} set in the environment",
      advice:
        "The worker's live connection does not go through this proxy. If this network reaches the server only through it, the connection will keep failing.",
    },
    eventLoop: {
      uptime: "running {{uptimeMinutes}} min",
      delay: "delay p99 {{p99Ms}} ms, max {{maxMs}} ms",
      stalls_one: "{{count}} stall",
      stalls_other: "{{count}} stalls",
      lastStall: "last stall {{lastStall}}",
      advice:
        "The worker was blocked for seconds at a time; the server may drop it meanwhile. Copy this report and share it.",
    },
    memory: {
      used: "{{rssMb}} MB in use",
      advice:
        "The worker uses a lot of memory; updating or restarting it frees it.",
    },
    disk: {
      free: "{{freeGb}} GB free at {{path}}",
      advice: "Free some disk space on this device.",
    },
    agent: {
      notInstalled: "Not installed",
      version: "version {{version}}",
      outdated: "update available",
      advice: "Sign in or update it from this device's Models & accounts tab.",
    },
    login: {
      verified: "account verified",
      local_login: "signed in on this device",
      not_signed_in: "not signed in",
      unavailable: "login status unavailable",
      error: "could not read the login: {{loginError}}",
    },
    workspaces: {
      allThere: "Every registered folder exists",
      missing_one: "{{count}} folder no longer exists: {{paths}}",
      missing_other: "{{count}} folders no longer exist: {{paths}}",
      advice: "Forget them below; they are only the worker's bookkeeping.",
    },
    activity: {
      notRun: "Not run since the worker started",
      last: "last {{at}}",
      seconds: "{{seconds}} s",
      error: "failed: {{error}}",
      skills_one: "{{count}} skill",
      skills_other: "{{count}} skills",
      workspaces_one: "{{count}} workspace",
      workspaces_other: "{{count}} workspaces",
    },
    connection: {
      lasted: "lasted {{seconds}} s",
      closedBy: {
        worker: "the worker gave up (nothing from the server)",
        server: "closed by the server",
        network: "cut by the network",
      },
      error: "error {{error}}",
      silence: "last data from the server {{seconds}} s before",
      blocked: "the worker itself was frozen for {{seconds}} s",
    },
    disconnect: {
      server: "server: {{reason}}",
      worker: "worker: {{line}}",
    },
    repair: {
      title: "Repairs",
      intro: "Each runs only when you confirm it, on this device.",
      running: "Repairing…",
      forgetCount_one: "Forget {{count}} missing folder",
      forgetCount_other: "Forget {{count}} missing folders",
      action: {
        "forget-missing-workspaces": "Forget missing folders",
        "clear-skill-scan-cache": "Clear the skill scan cache",
        "recheck-agents": "Re-check agents",
      },
      confirm: {
        "forget-missing-workspaces":
          "Forget folders that no longer exist? Click again",
        "clear-skill-scan-cache":
          "Rescan every skill from scratch next time? Click again",
        "recheck-agents": "Look up Claude Code and Codex again? Click again",
      },
      done: {
        "forget-missing-workspaces_one": "Forgot {{count}} missing folder.",
        "forget-missing-workspaces_other": "Forgot {{count}} missing folders.",
        "clear-skill-scan-cache":
          "Cleared; the next skill scan reads every skill again.",
        "recheck-agents": "Looking up Claude Code and Codex again.",
      },
    },
  },
  labels: {
    title: "What this computer has",
    intro:
      "Your assistant uses this to decide where new projects go: work that needs the company network or your work files goes to a computer that has them. Note what Foundry cannot detect; it adds the rest itself.",
    yours: "Noted by you",
    detected: "Detected by Foundry",
    keyLabel: "Name",
    valueLabel: "Value (optional)",
    keyPlaceholder: "network",
    valuePlaceholder: "corp",
    remove: "Remove {{label}}",
    add: "Add a note",
    suggested: "Common notes",
    suggest: "Add {{label}}",
    empty: "Nothing noted yet.",
    save: "Save notes",
    saved: "Notes saved.",
    saveFailed: "Couldn't save the notes.",
    loading: "Loading what this computer has…",
    loadFailed: "Couldn't load what this computer has.",
    retry: "Try again",
    invalid:
      "A name uses letters, digits, '.', '_' or '-' (up to 40); a value is one line without ':'.",
    nothingDetected:
      "Nothing detected yet. It appears once the computer reports in.",
    online: "Online {{percent}}% of the last {{days}} days",
    onlineHours: "Online {{percent}}% of the last {{hours}} hours",
    onlineNone:
      "Foundry hasn't followed this computer long enough to tell how often it is on.",
    facts: {
      os: "System: {{detail}}",
      arch: "Processor: {{value}}",
      toolchain: "{{detail}}",
      gpu: "Graphics: {{detail}}",
      reaches: "Reaches {{detail}}",
      "always-on": "Always on: connected nearly all of the last week",
    },
  },
};
