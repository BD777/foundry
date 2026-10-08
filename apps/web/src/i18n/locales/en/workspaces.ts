/** Workspaces: the hub, overview, selection and editing. */
export const workspaces = {
  /** Words the workspace lists and dialogs share. */
  shared: {
    online: "Online",
    offline: "Offline",
    deviceRemoved: "Device removed",
    details: "Details",
    viewDetails: "View details for {{name}}",
    switching: "Switching…",
    workspaceCount_one: "{{count}} workspace",
    workspaceCount_other: "{{count}} workspaces",
  },
  hub: {
    fallbackName: "Workspace",
    noPath: "Select or add a workspace to get started.",
    sectionsLabel: "Workspace settings sections",
    sections: {
      workspace: "Overview",
      settings: "Agents & execution",
      assets: "Assets",
      skills: "Skills",
      feishu: "Feishu Bot",
      sharing: "Sharing",
    },
    notes: {
      settings:
        "Agent profiles show their configuration scope. Worker capacity, runtime retention and device connections are shared by all workspaces on this device.",
      assets:
        "Assets available to this workspace. Device status and capacity are shared across workspaces.",
      skills:
        "Choose which server-published skills this workspace exposes to its Chats and Issues. A skill on this workspace's device can be added below; skills elsewhere stay unavailable until published to the server.",
      feishu:
        "Connect a Feishu Bot and associate a group thread as an interactive agent channel for this workspace.",
      sharing:
        "Share this workspace with other Foundry accounts. Access covers this workspace only, never the rest of its device.",
    },
  },
  switcher: {
    activated: "{{name}} is now active.",
    failed:
      "Could not switch to {{name}}. Your current location is unchanged. Try again.",
  },
  location: {
    regionLabel: "Current working location",
    open: "Open workspaces",
    title: "Workspaces",
    selectDevice: "Select device",
    selectWorkspace: "Select workspace",
    back: "Back to workspace",
    intro:
      "All your workspaces, grouped by the device they are on. Switch changes where you work; add, rename or remove workspaces right here.",
    currentLocation: "Current: <strong>{{location}}</strong>",
    noWorkspaceSelected: "No workspace selected",
    removedHistory: "Removed · history kept read-only",
    offlineSummary: "Offline · {{workspaces}}",
    noDevices: "No devices yet. Add one under Devices.",
    addWorkspace: "Add workspace",
    openDevice: "Device",
    openDeviceFor: "Open device {{device}}",
    findLabel: "Find workspace",
    searchPlaceholder: "Search workspaces by name or path…",
    sharedRole: "Shared · {{role}}",
    currentBadge: "Current",
    switchTo: "Switch to {{name}}",
    switch: "Switch",
    noMatches: "No matching workspaces.",
    noWorkspaces: "No workspaces on this device yet.",
  },
  overview: {
    gitStates: {
      ready: "Git initialized",
      unborn: "Git initialized · no initial commit",
      not_git: "Not a Git repository",
      nested: "Inside another Git repository",
      error: "Git unavailable",
    },
    statusTitle: "Workspace status",
    deviceOnline: "Device online",
    deviceOffline: "Device offline",
    rootRepository: "Root repository",
    checking: "Checking…",
    unknown: "Unknown",
    currentBranch: "Current branch",
    detachedHead: "Detached HEAD",
    trackedFiles: "Tracked files",
    uncommittedChanges: "Uncommitted changes",
    clean: "Clean",
    uniqueRepositories: "Unique repositories",
    notScanned: "Not scanned",
    device: "Device",
    noDevice: "No device",
    acceptedIssues: "Accepted Issues",
    notGitNote:
      "Root Git is not initialized. Inspection and rescanning do not initialize Git or commit files.",
    nestedNote:
      "Containing repository: <code>{{path}}</code>. Issue isolation requires its repository root.",
    checked: "HEAD <code>{{head}}</code> · Checked {{time}}",
    refreshStatus: "Refresh status",
    offlineNote:
      "Connect the device to inspect this workspace. No Git state is inferred while offline.",
    repositoriesTitle: "Git repositories",
    scanSummary:
      "{{unique}} · {{locations}} · {{worktrees}} · Last scanned {{time}}",
    uniqueCount_one: "{{count}} unique repository",
    uniqueCount_other: "{{count}} unique repositories",
    uniqueUnknown: "Unknown unique repositories",
    locationCount_one: "{{count}} Git location",
    locationCount_other: "{{count}} Git locations",
    worktreeCount_one: "{{count}} linked worktree",
    worktreeCount_other: "{{count}} linked worktrees",
    worktreeUnknown: "Unknown linked worktrees",
    noScan: "No repository scan has been recorded.",
    scanning: "Scanning repositories…",
    rescan: "Rescan repositories",
    filterLabel: "Filter repositories",
    filterPlaceholder: "Filter by path, type or status",
    rootWorkspace: ". · Root workspace",
    linkedWorktree: "linked worktree",
    noMatches: "No matching repositories.",
    noneFound: "No Git repositories were found in the last scan.",
    rescanHint:
      "Rescan to discover repositories without changing source files.",
    showMore: "Show more ({{count}} remaining)",
    scanWarnings: "Scan warnings ({{count}})",
    footnote:
      "Unique repositories share no Git common directory; locations include linked worktrees and uninitialized submodules. Repository statuses reflect the last scan. Scans skip symlinks and dependency/cache directories; only repos used by an Issue get candidate worktrees.",
  },
  details: {
    description:
      "Workspace details · Viewing details does not switch your working location.",
    closeLabel: "Close {{title}}",
    device: "Device",
    deviceRemoved: "Removed from Foundry",
    folder: "Folder",
    repository: "Repository",
    notGit: "Not a Git repository",
    noContainingRepository: "No containing repository",
    branch: "Branch",
    noBranch: "No branch",
    uncommittedChanges: "Uncommitted changes",
    cleanTracked: "Clean tracked files",
    repositories: "Repositories",
    inspected: "Inspected",
    inspecting: "Inspecting the folder on this device…",
    removedNote:
      "Removed device · This workspace is retained as read-only history and can no longer be inspected live or switched to. Local files were not deleted.",
    offlineNote:
      "Offline · Saved path only. Live repository status is unavailable.",
    failed: "Inspection failed.",
    retry: "Retry inspection",
    refresh: "Refresh inspection",
  },
  deviceList: {
    switchFailed:
      "Could not switch workspace. Your current location is unchanged. Try again.",
    switchFailedShort: "Could not switch workspace.",
    title: "Workspaces",
    ownedIntro:
      "Manage folders on {{device}}. Select a name for details; use Switch here to change your working location.",
    sharedIntro:
      "Workspaces on {{device}} shared with you. Only the account that paired this device can add folders.",
    add: "Add workspace",
    reconnect:
      "Reconnect this device to add or remove workspaces. Saved names and history remain available.",
    searchLabel: "Search device workspaces",
    searchPlaceholder: "Search workspace name or path…",
    switchToThis: "Switch to this workspace",
    currentWorkspace: "Current workspace",
    switchHere: "Switch here",
    roleAccess: "{{role}} access",
    actionsFor: "Actions for {{name}}",
    actions: "Actions",
    rename: "Rename display name",
    remove: "Remove from Foundry…",
    noMatches: "No matching workspaces. Try another name or path.",
    empty:
      "No workspaces registered yet. Add a folder on this device to get started.",
    added: "{{name}} registered. Your current location is unchanged.",
    renamed: "Display name saved as {{name}}.",
    removed: "{{name}} and its Foundry history removed. Local files preserved.",
    refreshFailed:
      "Saved successfully, but the list could not refresh. Reload this page; do not repeat the action.",
  },
  editor: {
    titles: {
      add: "Add workspace",
      remove: "Remove workspace",
      rename: "Rename workspace",
    },
    descriptions: {
      add: "Add an existing folder on {{device}} as a workspace. Foundry adds its setup files; existing project files are preserved. Your current workspace does not change.",
      remove:
        "Remove this registration and its Foundry history. This cannot be undone.",
      rename:
        "Change the display name in Foundry only. The folder, repository and workspace identity stay unchanged.",
    },
    saveFailed: "Could not save. Please try again.",
    addNote:
      "Initial setup may also initialize Git in a folder without a repository. Check the device and path before registering.",
    removeNote:
      "Chats, issues and run history in this workspace will be deleted from Foundry. Local files will not be deleted.",
    blocked:
      "This is your current workspace. Switch to another workspace before removing it.",
    folderOn: "Folder on {{device}}",
    displayName: "Display name",
    displayNameLabel: "Workspace display name",
    namePlaceholder: "Workspace name",
    reconnectRemove: "Reconnect this device to remove its registration.",
    reconnectAdd: "Reconnect this device to add a workspace.",
    submit: {
      remove: "Remove workspace and history",
      add: "Add workspace",
      rename: "Save display name",
    },
  },
  pathPicker: {
    label: "Workspace folder",
    placeholder: "/absolute/path/to/project",
    loading: "Loading folders…",
  },
  filePreview: {
    truncated: "Truncated read-only preview",
    readOnly: "Read-only workspace configuration",
  },
};
