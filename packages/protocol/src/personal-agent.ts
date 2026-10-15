// The Personal Agent ("助理"): each person's one assistant, its settings,
// memory, proposals, tasks, the digests it routes by and its audit trail
// (docs/personal-agent.md). The server owns every record here; the web reads
// and edits them through /api/personal-agent, the assistant through its MCP
// tools. Times are RFC 3339 strings.

import type { WorkspaceAccessRole, WorkspaceKind } from "./workspace.js";

/** "stopped": the stop switch was pressed; nothing runs until resumed. */
export type PersonalAgentState = "active" | "stopped";

/** What the server does when the assistant attempts an action. */
export type PersonalAgentDecision = "auto" | "ask" | "deny";

/**
 * The managed actions of §4, the keys of the policy. "rename_workspace"
 * covers name and purpose; "remove_skill_created" removes a skill from a
 * project the assistant created, "remove_skill" from any other; the first
 * "bind_connector" per account and project is what the decision governs.
 * Actions that are never allowed (deleting, sharing, device settings,
 * changing projects the person does not own) have no key: no setting can
 * allow them.
 */
export const personalAgentActions = [
  "create_workspace",
  "register_folder",
  "rename_workspace",
  "add_skill",
  "remove_skill_created",
  "remove_skill",
  "bind_connector",
  "unbind_connector",
  "archive_workspace",
  "restore_workspace",
] as const;

export type PersonalAgentAction = (typeof personalAgentActions)[number];

/** The decision for every managed action. */
export type PersonalAgentPolicy = Record<
  PersonalAgentAction,
  PersonalAgentDecision
>;

/** The panel's presets: ask more, the defaults of §4, hands off. */
export type PersonalAgentPolicyPreset = "cautious" | "default" | "hands_off";

/** How the assistant speaks: follow the person, plain words, technical. */
export type PersonalAgentSpeakingStyle = "auto" | "plain" | "technical";

export type PersonalAgentVerbosity = "concise" | "detailed";

/** What model work the assistant hands off runs with. */
export type PersonalAgentDelegateModel = "same_as_assistant" | "device_default";

/** A person's assistant (table personal_agents). */
export interface PersonalAgent {
  userId: string;
  /** The person's Personal Agent Workspace (kind personal_agent). */
  workspaceId: string;
  /** The device its folder is on (~/Foundry/personal-agent). */
  homeDeviceId: string;
  state: PersonalAgentState;
  settings: PersonalAgentSettings;
  /** The version of the embedded system prompt its sessions start with. */
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  /** When the stop switch was last pressed, while stopped. */
  stoppedAt?: string;
  /**
   * The workspaces it lived in before it moved to another computer, oldest
   * first (archived projects of the person's now): its earlier
   * conversations are there.
   */
  formerWorkspaceIds?: string[];
}

/**
 * Everything the settings panel edits (PUT /api/personal-agent/settings,
 * the person's cookie only). An empty string means the default named.
 */
export interface PersonalAgentSettings {
  /** Empty: "助理" or "Assistant", by language. */
  assistantName: string;
  /** A BCP 47 tag; empty: the account's language. */
  language: string;
  /**
   * An IANA zone. The web fills an empty one from the browser; still empty:
   * Asia/Shanghai when the language is Chinese, else UTC.
   */
  timezone: string;
  speakingStyle: PersonalAgentSpeakingStyle;
  verbosity: PersonalAgentVerbosity;
  /** Appended as "the person's requests"; at most 2,000 characters. */
  extraInstructions: string;
  policy: PersonalAgentPolicy;
  /** One entry per device the person owns; a missing one: work, no create. */
  devices: PersonalAgentDeviceSettings[];
  /** Where new projects go first; empty: the home device. */
  preferredDeviceId: string;
  /** The assistant's own profile on the home device; empty: its default. */
  assistantProfileId: string;
  /** The assistant's model; empty: the profile's default. */
  assistantModel: string;
  delegateModel: PersonalAgentDelegateModel;
  /** Signing in lands on /assistant. */
  homePage: boolean;
  /**
   * The simple interface (§10): the sidebar shows only the assistant and
   * settings, in every browser the person signs in to.
   */
  simpleInterface: boolean;
  /** The person's Feishu direct chat goes to the assistant. */
  feishuDirectChat: boolean;
  /** The Feishu app of that chat; empty: the person's app in Connectors. */
  feishuAppId: string;
  dailyDigest: boolean;
  /** "HH:MM", in timezone. */
  dailyDigestTime: string;
  /** "HH:MM": notifications outside these hours wait for the start. */
  activeHoursStart: string;
  activeHoursEnd: string;
  /** Things that need the person's decision are sent at any hour. */
  urgentAnytime: boolean;
  limits: PersonalAgentLimits;
}

/** What the assistant may do on one of the person's devices. */
export interface PersonalAgentDeviceSettings {
  deviceId: string;
  /** Hand work to projects on it. */
  allowWork: boolean;
  /** Create projects in its managed roots. */
  allowCreate: boolean;
}

/** The limits of §9; each at most its hard cap (personalagent/defaults.go). */
export interface PersonalAgentLimits {
  /** Sessions the assistant started that run at once. */
  concurrentSessions: number;
  /** Sessions it starts per day. */
  dailySessions: number;
  /** Projects it creates per day and per week. */
  dailyWorkspaces: number;
  weeklyWorkspaces: number;
  /** Assistant turns per hour, against loops. */
  hourlyTurns: number;
  /** Digest summary sessions per day. */
  dailyDigestSessions: number;
  /** A task nobody asked about for this long is reported as possibly stuck. */
  stuckAfterMinutes: number;
  /**
   * Tokens (input and output, as workers report them) its sessions may use
   * per calendar month; 0: no budget.
   */
  monthlyTokenBudget: number;
}

/** The counters the limits apply to, now. */
export interface PersonalAgentUsage {
  activeSessions: number;
  sessionsToday: number;
  workspacesToday: number;
  workspacesThisWeek: number;
  turnsThisHour: number;
  digestSessionsToday: number;
  tokensThisMonth: number;
}

/** GET /api/personal-agent: the caller's assistant, or how to set one up. */
export interface PersonalAgentOverview {
  /** Absent until the person sets it up. */
  agent?: PersonalAgent;
  homeDeviceOnline: boolean;
  /** Without an agent: the device the setup card offers (most online). */
  suggestedHomeDeviceId?: string;
  usage?: PersonalAgentUsage;
}

/** POST /api/personal-agent: set the assistant up on this device. */
export interface PersonalAgentSetupInput {
  deviceId: string;
  /** The browser's IANA time zone: the setting's first value. */
  timezone?: string;
}

/**
 * Where a memory came from. "stated": the person said it in the turn the
 * tool ran in; "edited": the person wrote it in the panel; "inferred": the
 * assistant's guess; "external": proposed by content (a web page, a
 * forwarded document, a helper's output). The server decides it.
 */
export type PersonalAgentMemoryOrigin =
  "stated" | "edited" | "inferred" | "external";

/**
 * "pending": external, waiting for the person; "superseded": replaced by a
 * newer item (supersedes points back); "forgotten": its content is erased.
 */
export type PersonalAgentMemoryStatus =
  "active" | "pending" | "superseded" | "forgotten";

/** One fact or preference about the person (table pa_memory). */
export interface PersonalAgentMemoryItem {
  id: string;
  /** At most 300 characters; empty once forgotten. */
  content: string;
  origin: PersonalAgentMemoryOrigin;
  status: PersonalAgentMemoryStatus;
  /** The session and message it came from. */
  sourceSessionId?: string;
  sourceInputId?: string;
  /** The item this one replaced. */
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  /** When the person last confirmed it, or wrote it. */
  verifiedAt?: string;
}

/** remember's op. */
export type PersonalAgentMemoryOp = "add" | "update" | "forget";

/** remember's item, and the panel's add and edit. */
export interface PersonalAgentMemoryInput {
  /** Required to update or forget. */
  id?: string;
  /** Required to add or update. */
  content?: string;
  /** The assistant guessed it: stored as inferred whatever the turn. */
  inferred?: boolean;
}

/** A proposal's kind: a managed action, or loosening the rules. */
export type PersonalAgentProposalKind = PersonalAgentAction | "relax_rules";

export type PersonalAgentProposalStatus =
  "pending" | "accepted" | "declined" | "expired" | "applied" | "failed";

/** Where the person answered a proposal. */
export type PersonalAgentProposalChannel = "web" | "feishu" | "reply";

/** An action waiting for the person's yes (table pa_proposals). */
export interface PersonalAgentProposal {
  id: string;
  /** The assistant session that proposed it; the result goes back there. */
  sessionId: string;
  kind: PersonalAgentProposalKind;
  /** The project it acts on; absent for creating one and for rules. */
  workspaceId?: string;
  /** The tool's arguments, applied exactly as approved. */
  spec: unknown;
  /** What it does, in the person's words, for the card. */
  summary: string;
  status: PersonalAgentProposalStatus;
  createdAt: string;
  /** 24 hours after createdAt. */
  expiresAt: string;
  decidedAt?: string;
  decidedVia?: PersonalAgentProposalChannel;
  /** Why applying it failed. */
  error?: string;
}

/** A write tool's answer when the policy says ask: a card is shown. */
export interface PersonalAgentNeedsConfirmation {
  status: "needs_confirmation";
  proposalId: string;
  summary: string;
  expiresAt: string;
}

/** update_rules' change: tightening applies, loosening is a proposal. */
export interface PersonalAgentRuleChange {
  action: PersonalAgentAction;
  decision: PersonalAgentDecision;
}

/**
 * "queued": waits for the project's writing session to finish; "asking":
 * its session ended with a question for the person.
 */
export type PersonalAgentTaskStatus =
  "queued" | "running" | "asking" | "done" | "failed" | "cancelled";

/** Work the assistant handed off and follows up (table pa_tasks). */
export interface PersonalAgentTask {
  id: string;
  /** The assistant session that follows it up; events go there. */
  conversationSessionId: string;
  /** The session doing it; absent while queued. */
  sessionId?: string;
  workspaceId: string;
  title: string;
  status: PersonalAgentTaskStatus;
  /** A read-only investigation: may run beside the project's writer. */
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
  endedAt?: string;
  /** Set once it ran past stuckAfterMinutes without anyone asking. */
  stuckSince?: string;
  /**
   * When listed: the name of the offline computer its session is queued
   * for. It starts by itself once that computer is back online.
   */
  waitingFor?: string;
}

/** Why the server wakes the assistant about a task. */
export type PersonalAgentTaskEventKind =
  "finished" | "failed" | "asked" | "silent";

/**
 * One event sent to the conversation following a task; events of one
 * conversation within two minutes arrive as one input.
 */
export interface PersonalAgentTaskEvent {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  kind: PersonalAgentTaskEventKind;
  at: string;
}

/**
 * What the server knows of one project for one person (table
 * workspace_digests): the deterministic part, computed without a model, and
 * the summary a digest session wrote.
 */
export interface WorkspaceDigest {
  workspaceId: string;
  name: string;
  kind: WorkspaceKind;
  /** The one-sentence purpose the assistant or the person gave. */
  purpose: string;
  deviceId: string;
  deviceLabel: string;
  deviceOnline: boolean;
  /** The person's role there. */
  accessRole: WorkspaceAccessRole;
  archived: boolean;
  unavailable: boolean;
  /** The first paragraph of its AGENTS.md or README. */
  intro: string;
  /** The latest five, newest first. */
  recentSessions: WorkspaceDigestSession[];
  openIssues: WorkspaceDigestIssue[];
  skills: string[];
  connectors: string[];
  gitBranch?: string;
  gitDirty?: boolean;
  lastActivityAt?: string;
  /** When the deterministic part was computed. */
  compiledAt: string;
  /** What it was computed from; a new one makes the summary dirty. */
  sourceRev: string;
  /** The summary predates the deterministic part. */
  dirty: boolean;
  /** The summary: one L0 line, the summary and when to route here. */
  l0: string;
  summary: string;
  routeWhen: string[];
  notWhen: string[];
  summarizedAt?: string;
}

export interface WorkspaceDigestSession {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface WorkspaceDigestIssue {
  id: string;
  title: string;
  status: string;
}

/**
 * The JSON a digest session must answer; anything else is discarded and
 * the previous summary kept. l0 at most 100 characters, summary at most 600.
 */
export interface WorkspaceDigestSummary {
  l0: string;
  summary: string;
  routeWhen: string[];
  notWhen: string[];
}

/** What the server knows of one of the person's devices. */
export interface DeviceDigest {
  deviceId: string;
  label: string;
  /** "macOS 15.1", as the worker reports it. */
  system: string;
  online: boolean;
  /** Runtimes signed in on it: "claude", "codex". */
  runtimes: string[];
  /** Its model services (profiles), by name. */
  modelServices: string[];
  /** Resource kinds available on it: screen control, browser, compute. */
  resources: string[];
  workspaceCount: number;
  compiledAt: string;
}

/** One find_workspace answer, best first. */
export interface WorkspaceCandidate {
  workspaceId: string;
  name: string;
  /** Why it matched, for the assistant. */
  reason: string;
  /** 0–1; only the order and the gaps between candidates mean anything. */
  score: number;
  /** The digest it matched: dirty or older than seven days is stale. */
  compiledAt: string;
  stale: boolean;
}

/** The kind of message, as step 1 of the prompt sorts it. */
export type PersonalAgentRequestClass =
  "stop" | "reply" | "question" | "remember" | "task" | "small_talk";

/** Where a request went: a project, a new one, the assistant, a question. */
export type PersonalAgentRouteTarget = "workspace" | "new" | "self" | "ask";

export type PersonalAgentRouteConfidence =
  "sure" | "fairly_sure" | "unsure" | "none";

/** One routing choice (table pa_routing_decisions), for evals and notes. */
export interface PersonalAgentRoutingDecision {
  id: string;
  sessionId: string;
  inputId?: string;
  /** The person's request, cut to 500 characters. */
  request: string;
  requestClass: PersonalAgentRequestClass;
  target: PersonalAgentRouteTarget;
  /** The project, for target workspace (and new, once created). */
  workspaceId?: string;
  confidence: PersonalAgentRouteConfidence;
  /** The candidates find_workspace offered, best first. */
  candidates: string[];
  /** The person redirected it. */
  corrected: boolean;
  correctedWorkspaceId?: string;
  createdAt: string;
}

/** What became of one write tool call. */
export type PersonalAgentActionOutcome =
  "applied" | "proposed" | "refused" | "failed";

/** Why a call was refused. */
export type PersonalAgentRefusal =
  "not_allowed" | "not_owner" | "limit" | "stopped" | "invalid" | "no_place";

/**
 * One write tool call, refused ones included, or one approved proposal
 * applied (table pa_actions, kept 90 days; the panel's activity).
 */
export interface PersonalAgentActionRecord {
  id: string;
  sessionId: string;
  /** The tool, or the proposal kind when applying an approved proposal. */
  tool: string;
  /** Its arguments, shortened for people. */
  argsSummary: string;
  workspaceId?: string;
  /** The policy's decision; absent when refused before the policy. */
  decision?: PersonalAgentDecision;
  outcome: PersonalAgentActionOutcome;
  refusal?: PersonalAgentRefusal;
  proposalId?: string;
  /** Set when an approved proposal was applied: where it was approved. */
  confirmedVia?: PersonalAgentProposalChannel;
  error?: string;
  createdAt: string;
}
