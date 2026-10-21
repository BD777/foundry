import {
  personalAgentActions,
  sessionInputEventLabel,
  type AgentProfileProjection,
  type AgentSession,
  type AgentSessionEvent,
  type DeviceProjection,
  type PersonalAgentAction,
  type PersonalAgentDecision,
  type PersonalAgentLimits,
  type PersonalAgentPolicy,
  type PersonalAgentPolicyPreset,
  type PersonalAgentProposal,
  type PersonalAgentSettings,
  type PersonalAgentTask,
} from "@bd777/foundry-protocol";
import {
  agentSessionDisplayEvents,
  responseStreamLabel,
} from "../../lib/agent-session-events";
import { deviceAwaitedBy } from "../../lib/device-wait";
import { isSessionLive } from "../../lib/session-status";

/** This browser's IANA time zone, "" when it reports none. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}

// The assistant's rules as the panel shows them. The server holds the same
// values (apps/server/internal/personalagent/defaults.go) and enforces them;
// these only let the page show presets, caps and the fixed words.

/** The words the channel handles before the model (§4, §8), whole message. */
const channelWords = {
  // i18n-ignore: the fixed words people type, matched whatever the language
  stop: ["停", "停下", "停止", "暂停", "stop", "pause"],
  // i18n-ignore: the fixed words people type, matched whatever the language
  resume: ["继续", "resume"],
  // i18n-ignore: the fixed words people type, matched whatever the language
  accept: ["好", "好的", "可以", "行", "ok", "yes"],
  // i18n-ignore: the fixed words people type, matched whatever the language
  decline: ["不", "不用", "不用了", "算了", "no", "no thanks"],
} as const;

export type ChannelCommand = keyof typeof channelWords;

/**
 * What a message does without the model, if it is one of the fixed words:
 * trimmed, case-folded, trailing punctuation ignored, as the server matches
 * them (personalagent.matchesWord).
 */
export function channelCommand(text: string): ChannelCommand | undefined {
  const word = text
    .toLowerCase()
    .replace(/[\p{P}\s]+$/u, "")
    .trim();
  for (const command of Object.keys(channelWords) as ChannelCommand[])
    if ((channelWords[command] as readonly string[]).includes(word))
      return command;
  return undefined;
}

export const defaultPolicy: PersonalAgentPolicy = {
  create_workspace: "auto",
  register_folder: "ask",
  rename_workspace: "auto",
  add_skill: "auto",
  remove_skill_created: "auto",
  remove_skill: "ask",
  bind_connector: "ask",
  unbind_connector: "ask",
  archive_workspace: "ask",
  restore_workspace: "auto",
};

export const policyPresets: PersonalAgentPolicyPreset[] = [
  "cautious",
  "default",
  "hands_off",
];

export function presetPolicy(
  preset: PersonalAgentPolicyPreset,
): PersonalAgentPolicy {
  if (preset === "default") return { ...defaultPolicy };
  const decision: PersonalAgentDecision =
    preset === "cautious" ? "ask" : "auto";
  const policy = Object.fromEntries(
    personalAgentActions.map((action) => [action, decision]),
  ) as PersonalAgentPolicy;
  if (preset === "hands_off") policy.bind_connector = "ask";
  return policy;
}

/** The preset a policy is exactly, if any. */
export function matchingPreset(
  policy: PersonalAgentPolicy,
): PersonalAgentPolicyPreset | undefined {
  return policyPresets.find((preset) => {
    const expected = presetPolicy(preset);
    return personalAgentActions.every(
      (action) => expected[action] === policy[action],
    );
  });
}

const strictness: Record<PersonalAgentDecision, number> = {
  deny: 2,
  ask: 1,
  auto: 0,
};

/** The actions a new policy lets the assistant do with less checking. */
export function loosenedActions(
  before: PersonalAgentPolicy,
  after: PersonalAgentPolicy,
): PersonalAgentAction[] {
  return personalAgentActions.filter(
    (action) =>
      strictness[after[action] ?? "ask"] < strictness[before[action] ?? "ask"],
  );
}

export const limitKeys = [
  "concurrentSessions",
  "dailySessions",
  "dailyWorkspaces",
  "weeklyWorkspaces",
  "hourlyTurns",
  "dailyDigestSessions",
  "stuckAfterMinutes",
  "monthlyTokenBudget",
] as const satisfies ReadonlyArray<keyof PersonalAgentLimits>;

export type LimitKey = (typeof limitKeys)[number];

/** §9's hard caps; absent: none. */
export const limitCaps: Partial<Record<LimitKey, number>> = {
  concurrentSessions: 8,
  dailySessions: 100,
  dailyWorkspaces: 10,
  weeklyWorkspaces: 30,
  hourlyTurns: 120,
  dailyDigestSessions: 200,
};

/** Limits that may be 0 (off); the others need at least 1. */
const zeroAllowed = new Set<LimitKey>(["monthlyTokenBudget"]);

export const extraInstructionsMaxChars = 2000;
export const memoryItemMaxChars = 300;

const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export type SettingsProblem =
  | { kind: "extraInstructions" }
  | { kind: "time"; field: "dailyDigestTime" | "activeHours" }
  | { kind: "limit"; key: LimitKey; max?: number; min: number };

/** What keeps a draft from being saved, in the order the panel shows. */
export function settingsProblems(
  settings: PersonalAgentSettings,
): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  if (settings.extraInstructions.length > extraInstructionsMaxChars)
    problems.push({ kind: "extraInstructions" });
  if (!clockPattern.test(settings.dailyDigestTime))
    problems.push({ kind: "time", field: "dailyDigestTime" });
  if (
    !clockPattern.test(settings.activeHoursStart) ||
    !clockPattern.test(settings.activeHoursEnd)
  )
    problems.push({ kind: "time", field: "activeHours" });
  for (const key of limitKeys) {
    const value = settings.limits[key];
    const min = zeroAllowed.has(key) ? 0 : 1;
    const max = limitCaps[key];
    if (
      !Number.isInteger(value) ||
      value < min ||
      (max !== undefined && value > max)
    )
      problems.push({ kind: "limit", key, min, max });
  }
  return problems;
}

/** The person's own conversation with the assistant, not its helpers. */
export function isAssistantSession(session: AgentSession): boolean {
  if (session.role) return session.role === "personal_agent";
  return (
    !session.parentSessionId &&
    !session.issueId &&
    (session.source === undefined || session.source === "chat")
  );
}

/** The conversation's latest sessions, oldest first. */
export function recentAssistantSessions(
  sessions: AgentSession[],
  limit: number,
): AgentSession[] {
  return sessions
    .filter(isAssistantSession)
    .sort(
      (a, b) =>
        Date.parse(a.startedAt ?? a.lastActivityAt ?? "") -
        Date.parse(b.startedAt ?? b.lastActivityAt ?? ""),
    )
    .slice(-limit);
}

/** One line of the conversation as the home page shows it. */
export interface AssistantLine {
  id: string;
  role: "person" | "assistant";
  text: string;
  at?: string;
  streaming?: boolean;
  /** The first line of a later session: a new conversation began. */
  startsConversation?: boolean;
}

/**
 * Starts every input the server, not the person, sends the assistant: a
 * task's event, a proposal's answer (personalagent.NoticePrefix). The
 * person never said it, so the conversation does not show it.
 */
const serverNoticePrefix = "[Foundry]";

function isServerNotice(text: string): boolean {
  return text.trimStart().startsWith(serverNoticePrefix);
}

/**
 * A session's events with its latest input among them. The input's own
 * event can be missing from what the page holds (it was streamed before the
 * session it belongs to arrived); the input then stands in for it, before
 * the first event after it.
 */
function withInputEvent(session: AgentSession): AgentSessionEvent[] {
  const events = agentSessionDisplayEvents(session);
  const input = session.input;
  if (
    !input?.prompt?.trim() ||
    events.some(
      (event) =>
        event.message?.kind === "user" && event.message.id === input.id,
    )
  )
    return events;
  const at = input.at ?? session.startedAt ?? "";
  const after = events.findIndex(
    (event) => Date.parse(event.at) > Date.parse(at),
  );
  const index = after < 0 ? events.length : after;
  const event: AgentSessionEvent = {
    id: `${session.id}_input_${input.id}`,
    sessionId: session.id,
    at,
    label: sessionInputEventLabel,
    detail: input.prompt,
    level: "info",
    message: { id: input.id, kind: "user", text: input.prompt, at },
    metadata: input.sentBySessionId
      ? { sentBySessionId: input.sentBySessionId }
      : undefined,
  };
  return [...events.slice(0, index), event, ...events.slice(index)];
}

/**
 * What the person and the assistant said, without its steps: the person
 * sees answers, not how they were found. A session's answer events either
 * update one answer (snapshots) or, typed, are separate answers.
 */
export function assistantLines(sessions: AgentSession[]): AssistantLine[] {
  const lines: AssistantLine[] = [];
  sessions.forEach((session, index) => {
    const start = lines.length;
    let answer: AssistantLine | undefined;
    const flush = () => {
      if (answer?.text.trim()) lines.push(answer);
      answer = undefined;
    };
    for (const event of withInputEvent(session)) {
      if (event.label === sessionInputEventLabel) {
        flush();
        const text = event.message?.text ?? event.detail;
        if (
          text.trim() &&
          !event.metadata?.sentBySessionId &&
          !isServerNotice(text)
        )
          lines.push({
            id: `${session.id}:${event.message?.id ?? event.id}`,
            role: "person",
            text,
            at: event.message?.at ?? event.at,
          });
        continue;
      }
      const isAnswer = event.message
        ? event.message.kind === "assistant"
        : event.label === responseStreamLabel;
      if (!isAnswer) continue;
      const id = `${session.id}:${event.message?.id ?? event.id}`;
      if (event.message && answer && answer.id !== id) flush();
      answer = {
        id: answer && !event.message ? answer.id : id,
        role: "assistant",
        text: event.message?.text ?? event.detail,
        at: answer?.at ?? event.message?.at ?? event.at,
      };
    }
    if (answer && isSessionLive(session)) answer.streaming = true;
    flush();
    if (index > 0 && lines.length > start)
      lines[start] = { ...lines[start]!, startsConversation: true };
  });
  return lines;
}

/** The latest session is answering now. */
export function assistantWorking(sessions: AgentSession[]): boolean {
  const latest = sessions[sessions.length - 1];
  return Boolean(latest && isSessionLive(latest));
}

/**
 * What the conversation shows after its last line: that the assistant waits
 * for its offline computer (never as working), that it is working on an
 * answer not yet streaming, or nothing.
 */
export function assistantActivity(
  latest: AgentSession | undefined,
  devices: readonly DeviceProjection[],
  lastLineStreaming: boolean,
): { waitingFor: DeviceProjection } | "working" | undefined {
  const awaited = deviceAwaitedBy(latest, devices);
  if (awaited) return { waitingFor: awaited };
  return latest && isSessionLive(latest) && !lastLineStreaming
    ? "working"
    : undefined;
}

/**
 * Proposals placed in the conversation: each after the last line said
 * before it was made. Decided ones stay where they were, without buttons.
 */
export function placeProposals<T extends { at?: string }>(
  lines: T[],
  proposals: PersonalAgentProposal[],
): Array<{ line: T } | { proposal: PersonalAgentProposal }> {
  const ordered = [...proposals].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const placed: Array<{ line: T } | { proposal: PersonalAgentProposal }> = [];
  let next = 0;
  for (const line of lines) {
    const at = Date.parse(line.at ?? "");
    while (
      next < ordered.length &&
      Number.isFinite(at) &&
      Date.parse(ordered[next]!.createdAt) < at
    )
      placed.push({ proposal: ordered[next++]! });
    placed.push({ line });
  }
  while (next < ordered.length) placed.push({ proposal: ordered[next++]! });
  return placed;
}

/**
 * Whether the page answers a message itself, without the model (§4, §8):
 * the stop switch, resuming a stopped assistant, a bare yes or no while a
 * card waits. Such a message acts at once, even while a reply is being
 * written; queued behind that reply, a stop would wait for the model.
 */
export function answeredWithoutModel(
  text: string,
  stopped: boolean,
  proposals: PersonalAgentProposal[],
): boolean {
  const command = channelCommand(text);
  if (command === "stop") return true;
  if (command === "resume") return stopped;
  if (command === "accept" || command === "decline")
    return answerableProposal(proposals) !== undefined;
  return false;
}

/** The proposal a bare "yes" or "no" answers: the newest still waiting. */
export function answerableProposal(
  proposals: PersonalAgentProposal[],
): PersonalAgentProposal | undefined {
  return proposals
    .filter((proposal) => proposal.status === "pending")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

const activeTaskStatuses = new Set<PersonalAgentTask["status"]>([
  "queued",
  "running",
  "asking",
]);

export function isTaskActive(task: PersonalAgentTask): boolean {
  return activeTaskStatuses.has(task.status);
}

const dayMs = 24 * 60 * 60 * 1000;

/**
 * "What it's doing": work under way first (newest first), then what ended
 * in the last day.
 */
export function visibleTasks(
  tasks: PersonalAgentTask[],
  now = Date.now(),
): { active: PersonalAgentTask[]; ended: PersonalAgentTask[] } {
  const newest = (a: PersonalAgentTask, b: PersonalAgentTask) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return {
    active: tasks.filter(isTaskActive).sort(newest),
    ended: tasks
      .filter(
        (task) =>
          !isTaskActive(task) &&
          now - Date.parse(task.endedAt ?? task.updatedAt) < dayMs,
      )
      .sort(newest),
  };
}

/** A conversation quiet this long starts a new session with the next message (§7). */
export const conversationQuietMs = 2 * 60 * 60 * 1000;

/**
 * The session the next message continues: the latest one, unless the
 * conversation went quiet or that session ended badly; then a new one.
 */
export function continuedSession(
  sessions: AgentSession[],
  now = Date.now(),
): AgentSession | undefined {
  const latest = sessions[sessions.length - 1];
  if (!latest || latest.status === "failed" || latest.status === "canceled")
    return undefined;
  const last = Date.parse(
    latest.lastActivityAt ?? latest.completedAt ?? latest.startedAt ?? "",
  );
  return Number.isFinite(last) && now - last > conversationQuietMs
    ? undefined
    : latest;
}

/** What a new conversation runs on: the chosen choice on the home computer. */
export function assistantRuntime(
  profiles: AgentProfileProjection[],
  homeDeviceId: string,
  settings: Pick<
    PersonalAgentSettings,
    "assistantProfileId" | "assistantModel"
  >,
):
  | {
      provider: AgentProfileProjection["runtime"];
      profileId: string;
      model?: string;
    }
  | undefined {
  const onHome = profiles.filter(
    (profile) => profile.deviceId === homeDeviceId,
  );
  const chosen =
    onHome.find((profile) => profile.id === settings.assistantProfileId) ??
    onHome.find((profile) => profile.status === "healthy") ??
    onHome[0];
  if (!chosen) return undefined;
  return {
    provider: chosen.runtime,
    profileId: chosen.id,
    ...(settings.assistantModel && chosen.id === settings.assistantProfileId
      ? { model: settings.assistantModel }
      : {}),
  };
}
