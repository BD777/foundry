import type {
  AssetProjection,
  ChatThread,
  DeviceProjection,
  Issue,
  ProviderHealth,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";

// The demo's data (?demo=1) and the browser test harnesses' starting state.
// i18n-ignore-file: sample workspace content, not interface copy

export const fixtureWorkspace: WorkspaceProjection = {
  id: "ws_atlas",
  name: "Atlas Web",
  localPath: "/Users/you/workspaces/atlas",
  baseline: "main",
  contextSummary:
    "Workspace context is authoritative. Skill packs carry reusable technique. Workers run locally and do not remember.",
  acceptedCount: 128,
  resolvedCount: 42,
};

export const fixtureDevice: DeviceProjection = {
  id: "dev_mbp",
  label: "MacBook Pro M4",
  status: "connected",
  lastSeenLabel: "online",
};

export const fixtureProviderHealth: ProviderHealth[] = [
  {
    provider: "claude",
    status: "healthy",
    authMode: "env",
    secretStored: "local",
  },
  {
    provider: "codex",
    status: "healthy",
    authMode: "local_config",
    secretStored: "local",
  },
];

export const fixtureIssues: Issue[] = [
  {
    id: "iss_112",
    shortId: "ISS-112",
    title: "Clarify which build is actually live",
    status: "pending",
    priority: "none",
    readiness: "direction",
    sourceInput:
      'Pasted feedback: "I could not tell which build was actually live."',
    inferredTask:
      'Pasted feedback: "I could not tell which build was actually live."',
    runtime: "mock",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: ["Clarify the feedback before production starts."],
    checks: ["Needs human direction"],
    updatedLabel: "Updated 40m",
  },
  {
    id: "iss_110",
    shortId: "ISS-110",
    title: "iOS simulator validation for the mobile shell",
    status: "pending",
    priority: "low",
    readiness: "unsuitable",
    sourceInput:
      "Try iOS simulator validation for the mobile shell before acceptance.",
    inferredTask:
      "Try iOS simulator validation for the mobile shell before acceptance.",
    runtime: "mock",
    skills: [],
    acceptanceCriteria: [
      "Confirm the iOS simulator asset exists before dispatch.",
    ],
    checks: ["Requires iOS Simulator asset"],
    updatedLabel: "Updated 1h",
  },
  {
    id: "iss_108",
    shortId: "ISS-108",
    title: "Explain that secrets stay local on setup",
    status: "pending",
    priority: "medium",
    readiness: "ready",
    sourceInput:
      "The provider setup page should explain that secrets stay on the device.",
    inferredTask:
      "The provider setup page should explain that secrets stay on the device.",
    runtime: "claude",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: ["Setup copy states that credentials stay local."],
    checks: ["Ready to execute"],
    updatedLabel: "Updated 18m",
  },
  {
    id: "iss_107",
    shortId: "ISS-107",
    title: "Declutter the dashboard top-right cluster",
    status: "pending",
    priority: "medium",
    readiness: "split",
    sourceInput:
      "Circled the crowded cluster in the top-right of the dashboard.",
    inferredTask:
      "Circled the crowded cluster in the top-right of the dashboard.",
    runtime: "codex",
    skills: [
      { id: "issue-splitting", name: "issue-splitting", version: "1.0" },
    ],
    acceptanceCriteria: [
      "Split the visual cleanup into executable sub-issues.",
    ],
    checks: ["Needs split"],
    updatedLabel: "Updated 25m",
  },
  {
    id: "iss_105",
    shortId: "ISS-105",
    title: "Add baseline comparison to the review view",
    status: "verifying",
    priority: "high",
    sourceInput: "Add a baseline comparison panel to the review surface.",
    inferredTask:
      "Add a baseline-vs-candidate comparison panel to the review surface, reusing the local preview host with changed-region highlighting.",
    runtime: "codex",
    skills: [
      {
        id: "baseline-comparison",
        name: "baseline-comparison",
        version: "1.2",
      },
      { id: "visual-qa", name: "visual-qa", version: "0.9" },
    ],
    acceptanceCriteria: [
      "Review state exposes one primary acceptance artifact.",
      "Baseline and candidate metadata are visible.",
      "Accept and request-changes actions are present.",
    ],
    checks: ["Typecheck passed", "Visual smoke passed", "A11y contrast passed"],
    artifact: {
      id: "art_105",
      issueId: "iss_105",
      kind: "preview",
      title: "Local Vite preview",
      summary: "Candidate worktree wt-3 compared against baseline main.",
    },
    run: {
      id: "run_2411",
      issueId: "iss_105",
      status: "completed",
      runtime: "codex",
      startedLabel: "2m ago",
      events: [
        {
          id: "evt_1",
          runId: "run_2411",
          at: "2m ago",
          label: "Loaded workspace context",
          detail: "AGENTS.md and installed skills",
          level: "info",
        },
        {
          id: "evt_2",
          runId: "run_2411",
          at: "90s ago",
          label: "Produced acceptance artifact",
          detail: "Local preview and comparison notes",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 8m",
  },
  {
    id: "iss_104",
    shortId: "ISS-104",
    title: "Calm down workspace home density",
    status: "in_progress",
    priority: "high",
    sourceInput:
      "The dashboard first screen feels busy. Make it calmer and move run logs behind details.",
    inferredTask:
      "Reduce visual density on the landing surface and move run logs behind progressive disclosure, keeping review and baseline prominent.",
    runtime: "claude",
    skills: [
      { id: "shadcn-ui-cleanup", name: "shadcn-ui-cleanup", version: "0.4" },
    ],
    acceptanceCriteria: [
      "Workspace home keeps input and review surfaces prominent.",
      "Run logs are progressively disclosed.",
      "Layout remains scan-friendly.",
    ],
    checks: ["Typecheck running", "Visual QA queued"],
    run: {
      id: "run_2418",
      issueId: "iss_104",
      status: "running",
      runtime: "claude",
      startedLabel: "45s ago",
      events: [
        {
          id: "evt_2418_1",
          runId: "run_2418",
          at: "2m 14s",
          label: "Dispatched to MacBook Pro M4",
          detail: "worktree wt-3 allocated",
          level: "info",
        },
        {
          id: "evt_2418_2",
          runId: "run_2418",
          at: "2m 06s",
          label: "Claude started",
          detail: "loaded AGENTS.md + workspace context",
          level: "info",
        },
        {
          id: "evt_2418_3",
          runId: "run_2418",
          at: "1m 40s",
          label: "Edited src/workspace/Home.tsx",
          detail: "reduced density, moved logs behind details",
          level: "info",
        },
        {
          id: "evt_2418_4",
          runId: "run_2418",
          at: "1m 02s",
          label: "Permission requested - pnpm typecheck",
          detail: "granted by workspace policy",
          level: "info",
        },
        {
          id: "evt_2418_5",
          runId: "run_2418",
          at: "0m 44s",
          label: "Typecheck passed",
          detail: "0 errors reported",
          level: "info",
        },
        {
          id: "evt_2418_6",
          runId: "run_2418",
          at: "now",
          label: "Building review preview",
          detail: "vite build -> local preview",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 2m",
  },
  {
    id: "iss_106",
    shortId: "ISS-106",
    title: "Extract shared status chip component",
    status: "in_progress",
    priority: "medium",
    sourceInput: "Reuse one status chip across acceptance, runs, and issues.",
    inferredTask:
      "Extract the shared status chip surface so issue cards, run rows, and acceptance panels render one consistent state language.",
    runtime: "codex",
    skills: [
      { id: "shadcn-ui-cleanup", name: "shadcn-ui-cleanup", version: "0.4" },
    ],
    acceptanceCriteria: [
      "Status tone, dot, and label rendering come from one component.",
      "Issue, run, and review states keep matching colors.",
      "No page-specific chip styling duplicates remain.",
    ],
    checks: ["Component extraction running", "Visual QA queued"],
    run: {
      id: "run_2417",
      issueId: "iss_106",
      status: "running",
      runtime: "codex",
      startedLabel: "46s ago",
      events: [
        {
          id: "evt_4",
          runId: "run_2417",
          at: "46s ago",
          label: "Editing shared component",
          detail: "Normalizing issue, run, and acceptance chip states",
          level: "info",
        },
      ],
    },
    updatedLabel: "Updated 46s",
  },
  {
    id: "iss_118",
    shortId: "ISS-118",
    title: "Tighten run timeline row spacing",
    status: "verifying",
    priority: "medium",
    sourceInput: "Row spacing on the run timeline feels loose — tighten it.",
    inferredTask:
      "Tighten vertical spacing on run-timeline rows without breaking the existing hierarchy.",
    runtime: "claude",
    skills: [{ id: "visual-qa", name: "visual-qa", version: "0.9" }],
    acceptanceCriteria: [
      "Run timeline rows are denser while retaining hierarchy.",
    ],
    checks: ["1 check needs attention"],
    artifact: {
      id: "art_118",
      issueId: "iss_118",
      kind: "preview",
      title: "Timeline spacing preview",
      summary: "Candidate run timeline spacing compared against the baseline.",
    },
    updatedLabel: "Updated 31m",
  },
  {
    id: "iss_201",
    shortId: "ISS-201",
    title: "Provider settings copy",
    status: "accepted",
    priority: "low",
    sourceInput:
      "Rewrite provider settings to emphasize that secrets stay local.",
    inferredTask:
      "Rewrite provider settings to emphasize that secrets stay local.",
    runtime: "claude",
    skills: [
      {
        id: "web-preview-acceptance",
        name: "web-preview-acceptance",
        version: "2.0",
      },
    ],
    acceptanceCriteria: [
      "Provider settings copy emphasizes local credentials.",
    ],
    checks: ["Baseline updated"],
    updatedLabel: "Updated 12m",
  },
  {
    id: "iss_098",
    shortId: "ISS-098",
    title: "Compact run timeline",
    status: "accepted",
    priority: "medium",
    sourceInput: "Denser run timeline rows for scanning.",
    inferredTask: "Denser run timeline rows for scanning.",
    runtime: "codex",
    skills: [
      {
        id: "web-preview-acceptance",
        name: "web-preview-acceptance",
        version: "2.0",
      },
    ],
    acceptanceCriteria: ["Run timeline rows scan more densely."],
    checks: ["Baseline updated"],
    updatedLabel: "Updated 3h",
  },
];

export const fixtureChats: ChatThread[] = [
  {
    id: "c1",
    title: "Does the workspace have its own context?",
    preview: "workspace vs. chat context",
    readonly: false,
    updatedLabel: "2d",
  },
  {
    id: "c2",
    title: "Brainstorm: a calmer landing surface",
    preview: "ideas for density + disclosure",
    readonly: false,
    updatedLabel: "3d",
  },
  {
    id: "c3",
    title: "Where should baseline compare live?",
    preview: "review surface vs. runs",
    readonly: false,
    updatedLabel: "5d",
  },
];

export const fixtureAssets: AssetProjection[] = [
  {
    id: "asset_worktrees",
    name: "Worktree pool",
    kind: "worktree_pool",
    status: "available",
    detail: "2 active · 4 available",
  },
  {
    id: "asset_archive",
    name: "Artifact archive",
    kind: "artifact_archive",
    status: "available",
    detail: "128 accepted increments",
  },
  {
    id: "asset_ports",
    name: "Preview ports",
    kind: "preview_ports",
    status: "available",
    detail: "4200–4210 · local",
  },
];
