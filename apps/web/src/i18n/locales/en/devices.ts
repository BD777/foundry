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
    offlineSince: "offline since {{time}}",
    view: "View →",
    sharedWithYou: "Shared with you",
    actionsFor: "Actions for {{device}}",
    removeFromFoundry: "Remove from Foundry…",
    emptyTitle: "No devices connected",
    emptyBody:
      "Use Add device to pair a Foundry worker with this server. It will appear here, along with its registered workspaces.",
  },
  recovery: {
    offlineSince: "Offline since {{time}} ({{relative}})",
    offline: "Offline",
    cause: {
      device_closed:
        "The device closed the connection unexpectedly: its Foundry worker stopped, or the machine shut down, went to sleep or lost its network.",
      network:
        "The connection went silent until it timed out, which usually means the network between the device and Foundry.",
      server: "Foundry’s server ended the connection.",
      unknown: "Foundry did not record why it stopped answering.",
    },
    bringBack: "Bring it back",
    intro: "On {{device}}, signed in as {{user}} (for example over ssh), run:",
    introNoUser:
      "On {{device}}, signed in as the account that runs Foundry (for example over ssh), run:",
    unitAssumed:
      "{{unit}} is the name Foundry installs by default; this device has not reported its own yet.",
    unitHelpLabel: "About the service name",
    sharedOwner: "Only the owner of {{device}} can bring it back.",
    steps: {
      status: "Check the worker",
      linger:
        "Keep it running after you log out (an administrator runs this once)",
      restart: "Start it again",
      logs: "Read why it stopped",
      memory: "See whether it ran out of memory",
      foreground: "Run it in this terminal instead",
    },
    copy: "Copy",
    copied: "Copied",
    copyLabel: "Copy the commands to {{step}}",
    keepRunning: {
      title: "Keeps running after you log out",
      yes: "Yes: the account’s services keep running after it logs out.",
      no: "No: when {{user}} logs out of {{device}}, systemd stops the Foundry worker and the device goes offline. An administrator turns this on once:",
      noAlert:
        "When {{user}} logs out of {{device}}, systemd stops the Foundry worker and the device goes offline. An administrator turns this on once:",
      noTitle: "Stops when {{user}} logs out",
    },
    oom: {
      title: "Stopped for lack of memory",
      detail_one:
        "In the last 7 days the system stopped a Foundry process on {{device}} once for lack of memory.",
      detail_other:
        "In the last 7 days the system stopped Foundry processes on {{device}} {{count}} times for lack of memory.",
      last: "Last at {{time}}.",
    },
    swap: {
      title: "Add swap",
      intro:
        "{{device}} has no swap. With {{memory}} of memory, adding 2 GB of swap keeps the system from stopping sessions or the worker when memory runs out:",
    },
  },
  readiness: {
    checklistLabel: "What {{device}} needs to run agents",
    pairedIntro:
      "Install the agents it will run; nothing installs until you choose.",
    worker: {
      title: "Foundry worker",
      online: "Connected.",
      offline:
        "Offline. Start {{device}} and its Foundry worker; this list updates by itself.",
    },
    runtime: {
      unknown: "Shown once {{device}} is online.",
      missing: "Not installed on {{device}}.",
      missingAssigned_one:
        "Not installed on {{device}}. The model provider assigned there needs it.",
      missingAssigned_other:
        "Not installed on {{device}}. The {{count}} model providers assigned there need it.",
      installing: "Installing on {{device}}… {{elapsed}}",
      installFailed: "Could not install it on {{device}}.",
      outdated:
        "{{version}} is older than the {{target}} Foundry needs. Foundry is managing it and will update it.",
      updating: "Updating on {{device}}… {{elapsed}}",
      externalUpdate: "{{version}}, your own copy · {{target}} available.",
      externalUpdateHelpLabel: "About your own copy",
      externalUpdateHelp:
        "Foundry can’t update a copy you installed yourself. It can install its own copy and keep that one up to date.",
      readyManaged:
        "{{version}}, managed by Foundry; it updates automatically.",
      readyExternal: "{{version}}, your own copy.",
      ready: "Installed.",
      notSignedIn:
        "Not signed in to an official account; model providers don’t need one.",
      offline: "Install it once {{device}} is online.",
      notOwner: "Ask the owner of {{device}} to install it.",
    },
    actions: {
      install: "Install",
      installLabel: "Install {{name}} on {{device}}",
      installBoth: "Install both",
      installBothLabel: "Install Claude Code and Codex on {{device}}",
      retry: "Retry install",
      retryLabel: "Retry installing {{name}} on {{device}}",
      update: "Update now",
      updateLabel: "Update {{name}} on {{device}} now",
      switch: "Use Foundry-managed copy",
      switchLabel: "Install a Foundry-managed copy of {{name}} on {{device}}",
    },
    memory: {
      title: "Memory",
      low: "{{device}} has {{memory}} of memory; Claude Code asks for 4 GB. Sessions may be slow or stop.",
    },
    log: "Installer output",
    summary: {
      needsSetup: "Needs setup",
      installing: "Installing…",
    },
    picker: {
      install: "Install {{name}} on {{device}}",
      installing: "Installing {{name}} on {{device}}…",
      failed: "Retry installing {{name}} on {{device}}",
      detail:
        "Not installed on this device; the choices that run on it are unavailable until it is.",
      action: "Install",
    },
    assign: {
      willInstall:
        "{{name}} isn’t installed on {{device}}; assigning installs it.",
      installing: "{{name}} is being installed on {{device}}.",
      offline:
        "{{name}} isn’t installed on {{device}}. Install it once {{device}} is online.",
      notOwner:
        "{{name}} isn’t installed on {{device}}. Ask the owner of {{device}} to install it.",
      andInstall: "Assign and install {{name}}",
      andInstallLabel:
        "Assign {{connection}} to {{device}} and install {{name}} there",
    },
  },
  status: {
    online: "Online",
    reconnecting: "Reconnecting…",
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
    reconnecting:
      "The device is reconnecting. It usually recovers within seconds; sign-in and execution are unavailable until it does.",
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
    runnerTitle: "The session runner has not switched to the new version yet",
    changeTo: "to",
    helpLabel: "How Worker updates work",
    helpConnection:
      "A Worker has two parts. The connection service links this device to the server; Update restarts it with the new version at once.",
    helpRunner:
      "The session runner runs the agents' turns. So that no running turn is cut off, it switches by itself once its turns end; you do nothing after Update.",
    helpSwitchNow:
      "Switch now does not wait: it stops the running turns (their sessions stay) and switches at once.",
    running: "Runs worker {{version}}.",
    proxyFallbackDirect:
      "Can't reach Foundry through the proxy {{proxy}}, so this device connected directly instead.",
    proxyFallbackEnvironment:
      "Can't reach Foundry through the proxy {{proxy}}, so this device connected through the proxy {{environmentProxy}} from its environment instead.",
    proxyFallbackBody:
      "Since {{since}}. It switches back by itself once {{proxy}} works again.",
    proxyStopUsing: "Stop using this proxy",
    proxyUseAnother: "Use another proxy…",
    proxyUseAnotherTitle: "Use another proxy",
    proxyUseAnotherDescription:
      "From now on this device connects to Foundry through this address.",
    proxyAddress: "Proxy address",
    proxyAddressPlaceholder: "http://host:port",
    proxyAddressHint:
      "http://, https://, socks5:// or socks5h://, then the host and port. A user name and password may go before the host (user:password@).",
    proxyAddressInvalid:
      "This isn't a proxy address: start with http://, https://, socks5:// or socks5h://, then the host and port, with nothing after it.",
    proxyChanged: "Saved. The device reconnects in a few seconds.",
    proxyChangeFailed: "Couldn't change the proxy: {{error}}",
    unknownVersion: "older than 0.5.7",
    serverBuild: "This server serves {{version}}.",
    serverNpm: "This server uses the npm release.",
    serverLoading: "Reading which Worker this server serves…",
    serverUnknown:
      "Could not read which Worker this server serves; trying again. Updating is offered once it is known.",
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
    connectionService: "Connection service",
    sessionRunner: "Session runner",
    stateCurrent: "Up to date",
    updateWorker: "Update Worker",
    runner: {
      pending: "Waiting to switch",
      switching: "Switching…",
      failed: "Switch failed",
      unavailable: "Not answering",
      notAnswering:
        "The session runner does not answer. The connection service keeps trying and replaces it if it stays wedged; new turns wait meanwhile.",
      reclaiming:
        "The session runner stopped answering and is being replaced; new turns wait for the new one.",
      badgeUnavailable: "Runner not answering",
      waitingUntil_one:
        "{{count}} turn is running. New turns wait for the new runner until {{time}}; running turns are never stopped unless you switch now.",
      waitingUntil_other:
        "{{count}} turns are running. New turns wait for the new runner until {{time}}; running turns are never stopped unless you switch now.",
      pastDeadline_one:
        "{{count}} turn kept running past {{time}}, so new turns use the old runner for now. It switches by itself as soon as no turn runs.",
      pastDeadline_other:
        "{{count}} turns kept running past {{time}}, so new turns use the old runner for now. It switches by itself as soon as no turn runs.",
      background:
        "No turn runs, but background tasks, timers or services keep the old runner busy; it switches when they end.",
      held_one: "{{count}} new turn waits for the new runner.",
      held_other: "{{count}} new turns wait for the new runner.",
      failedReason:
        "The last switch failed: {{error}}. It is tried again in a few minutes; new turns run on the old runner meanwhile.",
      switchNow: "Switch now",
      confirmTitle: "Switch the session runner now?",
      confirmDescription:
        "The turns below stop now. Their sessions stay, and each continues with its next message. Background tasks in the old runner stop too.",
      confirmNone:
        "No turn runs now. Background tasks, timers or services of the old runner stop.",
      loading: "Reading the running turns…",
      backgroundOnly: "Background tasks only",
      untitled: "Session {{id}}",
      confirm_one: "Stop {{count}} turn and switch",
      confirm_other: "Stop {{count}} turns and switch",
      confirmEmpty: "Switch now",
      switchingNow: "Stopping and switching…",
      switchFailed: "Could not switch: {{error}}",
      badgePending: "Runner waiting to switch",
      badgeSwitching: "Runner switching",
      badgeFailed: "Runner switch failed",
    },
    updateAllRunners:
      "Session runners waiting to switch: {{devices}}. Each switches when its running turns end; open a device to switch now.",
  },
  outsideFiles: {
    title: "Files in chats",
    allow: "Open this device's files outside workspaces from chats",
    hint: "Opens files an answer names elsewhere on {{device}}. Only you, the device's owner, can; people you share workspaces with and agents cannot.",
    helpLabel: "About files outside workspaces",
    help: "Credential stores, browser profiles and system secrets are never opened, and files that look like secrets stay hidden until you show them.",
    saving: "Saving…",
    failed: "Could not change this setting. Try again.",
  },
  settings: {
    title: "Execution settings",
    intro: "Shared by every workspace on {{device}}.",
    liveTitle: "Current concurrency",
    mode: {
      adaptive: "Adaptive",
      forced: "Forced",
    },
    currentLimit: "Limit",
    running: "Running",
    queued: "Queued",
    limitedTurns: "Limited turns",
    exemptTurns: "Exempt turns",
    turnLoad: "{{running}} running / {{queued}} queued",
    cpuCores: "CPU cores",
    sampledAt: "Sampled {{time}}",
    basisTitle: "Why this limit",
    memory: "Memory available / total",
    cpuPressure: "CPU pressure",
    memoryPressure: "Memory pressure",
    percent: "{{value}}%",
    estimatesTitle: "Per-session estimates",
    estimateMeta: "{{runtime}} · typical {{typical}} · peak {{peak}}",
    estimateCpu: "{{cpu}} CPU",
    defaultEstimate: "Default estimate",
    unknownWorkspace: "Unknown workspace",
    unknownWorkspaceWithId: "Unknown workspace · {{id}}",
    unknownRuntime: "Unknown runtime",
    noEstimates: "The worker has not learned per-session usage yet.",
    liveUnavailable:
      "The worker has not reported live capacity yet. It will appear after the next heartbeat.",
    adaptiveHelp:
      "Uses typical turn size and available memory (including swap) for the target, never below the parallel floor; sustained CPU pressure only lowers it to that floor.",
    forcedToggle: "Force a limit (overclock)",
    forcedHelp:
      "Use this fixed limit instead of the adaptive target while the device has enough memory.",
    forcedLimit: "Forced limit",
    forcedLimitHint: "Whole turns from 1 to 16.",
    invalidForcedLimit: "Enter a whole number from 1 to 16.",
    forcedWarningTitle: "Forced limit enabled",
    forcedWarning:
      "This may exceed the adaptive limit and make the device slower. New tasks still pause when memory is too low.",
    migrationTitle: "Concurrency is now adaptive",
    migrationBody:
      "Your previous fixed turn limit was migrated to adaptive mode. You can force a limit below if you need one.",
    dismiss: "Dismiss",
    hardHoldTitle: "Memory is too low; new tasks are paused",
    hardHoldBody:
      "Running turns continue. Queued turns start when available memory recovers.",
    runtimeCache: "Keep idle agent process (minutes)",
    runtimeCacheLabel: "Minutes to keep an idle agent process",
    runtimeCacheHint:
      "A message sent within this time reuses the running process and starts faster. It does not change the model provider's prompt cache.",
    saved: "Settings saved.",
    saveFailed: "Could not save settings.",
    save: "Save settings",
    removeTitle: "Remove device",
    removeBody:
      "Delete {{device}} from this Foundry server, with its workspaces and their chats, issues and run history. Nothing on the machine is deleted.",
  },
  add: {
    dialogTitle: "Add or repair a device",
    dialogIntro:
      "Pair a new machine with one command, or check and update a device that is already set up.",
    title: "Add a new device",
    intro:
      "Run one command in a terminal on the machine that should do the work (macOS or Linux with Node.js 20 or later). It installs the worker, pairs it with your account and starts it at login.",
    tokenExpiry: "The token works once and expires at {{time}}.",
    tokenWorkspace:
      "The device starts without a workspace: once it is online, add folders from the Workspaces page, or add <code>{{flag}}</code> to register one now.",
    mirrorNote:
      "If npm uses a private mirror that cannot be reached, add <code>{{flag}}</code> to the command.",
    mirrorHelpLabel: "About private npm mirrors",
    repairTitle: "Check or repair a device already set up",
    repairIntro:
      "Run on that machine. The first command checks it without downloading anything; the second updates the worker and restarts it.",
    repairLegacy:
      "A device set up with an earlier version gets this command after running <code>{{update}}</code> once.",
    repairServerBuild:
      "The update above follows it. A device on the npm release, or set up with an earlier version, switches to it by running this once:",
    repairServerBuildTitle:
      "This server serves its own worker build ({{version}}).",
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
      "This deletes the device from this Foundry server with everything Foundry keeps about it. It cannot be undone, but nothing on the machine itself is deleted.",
    failed: "Could not remove this device.",
    notFound: "This device is no longer registered. Refresh the list.",
    workspaces_one:
      "{{count}} workspace on this device is deleted with its chats, sessions, issues, queues and run history.",
    workspaces_other:
      "{{count}} workspaces on this device are deleted with their chats, sessions, issues, queues and run history.",
    localKept:
      "Local folders and repositories, Claude/Codex sign-ins, provider keys stored on the machine, and worker settings are not deleted.",
    connectionsKept:
      "Model providers and their sealed keys stay available for every other device; only this device's access is revoked.",
    online:
      "The worker is online. It will be disconnected now, stops what it runs, will not reconnect, and must be set up again on this machine to return.",
    offline:
      "The device is offline. Whatever it left running is deleted with it; if it contacts this server again it is told it was removed. Set it up again on the machine to bring it back.",
    blocked:
      "This device owns your current working location. Switch to a workspace on another device before removing it.",
    turnsRunning:
      "Turns are running on this device right now. Removing it stops them and deletes their chats.",
    stopAndRemove: "Stop turns and remove",
    removing: "Removing…",
    remove: "Remove device",
  },
  access: {
    title: "Models & accounts",
    summaryIntro:
      "What chats on {{device}} can run on. Sign in, check, set defaults and promote on Model providers.",
    manage: "Manage in Model providers",
    summary: {
      claude: "Claude subscription",
      codex: "ChatGPT subscription",
      server: "Server API providers",
      found: "Found in its configuration",
      environments: "Launch environments",
      signedIn: "Signed in",
      signedInAs: "Signed in as {{account}}",
      notSignedIn: "Not signed in",
      none: "None",
    },
  },

  resources: {
    title: "Resources",
    intro: "Software on {{device}} that sessions may use.",
    introHelpLabel: "About resource detection",
    introHelp:
      "Its worker detects them when it connects. Foundry never installs resources.",
    detected: "Resources detected again.",
    settingsOpen:
      "System Settings is open on {{device}} ({{panes}}). Turn on the Foundry worker there, then choose Detect again.",
    promptsShown:
      "{{device}} showed its permission prompts. Allow them there, then choose Detect again.",
    unreachable: "Could not reach the device.",
    detecting: "Detecting…",
    detectAgain: "Detect again",
    screenAccess:
      "To let sessions capture and control this Mac, allow the program running the Foundry worker under Screen Recording and Accessibility. The prompts and System Settings open on {{device}}.",
    screenAccessGrantTo:
      "To let sessions capture and control this Mac, allow the program running the Foundry worker (<code>{{grantTo}}</code>) under Screen Recording and Accessibility. The prompts and System Settings open on {{device}}.",
    asking: "Asking the device…",
    screenAccessTitle: "Screen control needs your permission",
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
      "A report from this device's worker on itself: its connection, runtime, agents and the end of its log.",
    introHelpLabel: "About diagnostics",
    introHelp:
      "Secrets are removed from the report. It makes no model requests.",
    run: "Run diagnostics",
    running: "Running…",
    runningNotice: "The worker is checking itself; this takes up to a minute.",
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
      sandbox: "Sandbox isolation (bwrap)",
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
      set: "Proxy {{proxy}}",
      advice:
        "Check the worker proxy address, authentication and NO_PROXY bypass list on the device.",
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
    sandbox: {
      available: "Bubblewrap sandbox is available",
      missing: "Bubblewrap (bwrap) is missing or user namespaces are disabled",
      advice:
        "Install bubblewrap ('sudo apt install -y bubblewrap') on the device to enable sandboxed verification.",
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
      helpLabel: "About repairs",
      intro: "Each runs only when you confirm it, on this device.",
      running: "Repairing…",
      forgetCount_one: "Forget {{count}} missing folder",
      forgetCount_other: "Forget {{count}} missing folders",
      action: {
        "forget-missing-workspaces": "Forget missing folders",
        "clear-skill-scan-cache": "Clear the skill scan cache",
        "recheck-agents": "Re-check agents",
        "install-bubblewrap": "Install bubblewrap (bwrap)",
      },
      confirm: {
        "forget-missing-workspaces":
          "Forget folders that no longer exist? Click again",
        "clear-skill-scan-cache":
          "Rescan every skill from scratch next time? Click again",
        "recheck-agents": "Look up Claude Code and Codex again? Click again",
        "install-bubblewrap":
          "Attempt to install bubblewrap via package manager? Click again",
      },
      done: {
        "forget-missing-workspaces_one": "Forgot {{count}} missing folder.",
        "forget-missing-workspaces_other": "Forgot {{count}} missing folders.",
        "clear-skill-scan-cache":
          "Cleared; the next skill scan reads every skill again.",
        "recheck-agents": "Looking up Claude Code and Codex again.",
        "install-bubblewrap": "Bubblewrap installed successfully.",
      },
    },
  },
  labels: {
    title: "What this computer has",
    intro: "Your assistant uses this to decide where new projects go.",
    helpLabel: "About what this computer has",
    help: "Work that needs the company network or your work files goes to a computer that has them. Note what Foundry cannot detect; it adds the rest itself.",
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
