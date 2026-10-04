/** Assets: what a workspace's device has, shown read-only. */
export const assets = {
  device: {
    section: "Device",
    logs: "Logs",
    openLogs: "Open device logs",
    refresh: "Refresh",
    refreshDevice: "Refresh device",
    workersActive_one: "{{count}} worker active",
    workersActive_other: "{{count}} workers active",
    noDevice: "No device",
    lastConnected: "{{device}} · last connected {{when}}",
    justNow: "just now",
    never: "never",
    online: "Online",
    offline: "Offline",
    workdir: "Workdir",
    agents: "Agents",
    agentsConfigured: "{{configured}}/{{total}} configured",
    scope: "Scope",
    localDevice: "Local device",
  },
  status: {
    blocked: "Blocked",
    leased: "In use",
    missing: "Missing",
    available: "Available",
    synced: "Synced",
    present: "Present",
    notReported: "not reported by daemon",
  },
  capacity: {
    previewSetup:
      "Not set up: copy .foundry/preview.example.json to .foundry/preview.json to enable previews",
    worktrees: "One git worktree per Issue",
    worktreesAt: "One git worktree per Issue · {{path}}",
    evidence:
      "Check results and evidence for each Issue; accepted changes merge into the repository",
    evidenceAt:
      "Check results and evidence for each Issue; accepted changes merge into the repository · {{path}}",
    title: "Execution capacity",
    worktreePool: "Issue worktrees",
    previewPorts: "Preview ports",
    artifactArchive: "Evidence store",
  },
  context: {
    title: "Context",
    workspace: "Workspace",
    workspaceMeta: "{{name}} · configured baseline: {{baseline}}",
    skillsConfig: "Skills config",
    skillsMeta_one: "{{count}} skill · {{path}}",
    skillsMeta_other: "{{count}} skills · {{path}}",
  },
};
