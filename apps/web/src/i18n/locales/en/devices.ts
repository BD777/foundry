/** Devices: the list, adding, settings, access, resources and removal. */
export const devices = {
  list: {
    title: "Devices",
    intro:
      "Choose a device to browse its workspaces, manage agent logins, or configure execution.",
    add: "Add device",
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
    sectionWorkspaces: "Workspaces",
    sectionResources: "Resources",
    sectionAgents: "Models & accounts",
    sectionSkills: "Skills",
    sectionSettings: "Settings",
    sharedTitle: "Shared with you",
    sharedBody:
      "You reach this device through its workspaces. Models, accounts, skills and settings are managed by the account that paired it.",
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
    title: "Add a device",
    intro:
      "Run one command in a terminal on the machine that should do the work (macOS or Linux with Node.js 20 or later). It installs the worker, pairs it with your account and starts it at login.",
    tokenNote:
      "The token works once and expires at {{time}}. The first workspace is ~/Foundry; add <code>{{flag}}</code> to choose another, and add more later under the device's Workspaces.",
    updateNote:
      "A machine that already runs a Foundry worker is left as it is. To update a worker later, run <code>{{update}}</code> on it; <code>{{uninstall}}</code> removes it.",
    copyCommand: "Copy command",
    newToken: "New token",
    creating: "Creating…",
    create: "Create pairing command",
    failedTitle: "Could not create a pairing token",
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
      "Server API connections and their sealed keys stay available for every other device; only this device's access is revoked.",
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
      "Choose an account or API connection when starting a chat. Both run on <strong>{{device}}</strong>.",
    sources: "AI access sources",
    accountsTitle: "Official accounts",
    accountsHint: "Sign in separately on this device",
    connectionsTitle: "Server API connections <em>{{total}}</em>",
    connectionsHint: "Shared configuration · Explicit device access",
    accountsExplanation:
      "Use your ChatGPT or Claude subscription. Credentials stay on this device; no server connection is needed.",
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
  },
};
