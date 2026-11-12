import type {
  MessageChannel,
  MessageChannelConnectorScope,
  MessageChannelInput,
  MessageChannelList,
  MessageChannelRule,
  MessageChannelSource,
  MessageChannelTriState,
  MessageConversationKind,
  PersonalAgentInboxEntry,
} from "@bd777/foundry-protocol";

// Message channels (DEV-203): the editor's draft and its conversion to the
// server's MessageChannelInput (contracts/models/message_channels.yaml).

export const conversationKinds = [
  "direct",
  "group",
  "channel",
  "other",
] as const satisfies readonly MessageConversationKind[];

export const triStates = [
  "any",
  "yes",
  "no",
] as const satisfies readonly MessageChannelTriState[];

/** What the channel's sessions may do with the source connector. */
export type SourceAccess = "read" | "confirm" | "direct";
export const sourceAccesses: readonly SourceAccess[] = [
  "read",
  "confirm",
  "direct",
];

export const channelBounds = {
  name: 80,
  rules: 20,
  prefixes: 10,
  prefix: 40,
  guide: 8000,
  perHour: { min: 1, max: 1000, initial: 20 },
  perDay: { min: 1, max: 10000, initial: 100 },
  concurrency: { min: 1, max: 10, initial: 3 },
} as const;

export type ChannelLimitKey = "perHour" | "perDay" | "concurrency";
export const channelLimitKeys: readonly ChannelLimitKey[] = [
  "perHour",
  "perDay",
  "concurrency",
];

/** One rule as the editor holds it: lists as the text the person types. */
export interface RuleDraft {
  rule: MessageChannelRule;
  prefixes: string;
  conversationIds: string;
}

export interface ChannelDraft {
  name: string;
  enabled: boolean;
  /** The source's accountId; "" until one is chosen. */
  sourceAccountId: string;
  rules: RuleDraft[];
  guide: string;
  sessionKey: "conversation" | "thread";
  access: SourceAccess;
  inheritOtherConnectors: boolean;
  limits: Record<ChannelLimitKey, number>;
}

/** The labels of the new-channel template's three rules, localized. */
export interface TemplateLabels {
  direct: string;
  groupMention: string;
  selfTest: string;
}

function newRuleId(): string {
  return `rule_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function blankRule(label = "", id = newRuleId()): RuleDraft {
  return {
    rule: {
      id,
      label,
      enabled: true,
      conversationKinds: ["direct"],
      mentionsMe: "any",
      fromSelf: "no",
      textPrefixes: [],
    },
    prefixes: "",
    conversationIds: "",
  };
}

/**
 * A new channel: three enabled rules that each still need a prefix the
 * person types (none is filled in for them), the source's writes left to
 * the assistant, other connectors as the assistant has them.
 */
export function newChannelDraft(
  labels: TemplateLabels,
  sourceAccountId = "",
  makeId: () => string = newRuleId,
): ChannelDraft {
  const rule = (
    label: string,
    kinds: MessageConversationKind[],
    mentionsMe: MessageChannelTriState,
    fromSelf: MessageChannelTriState,
  ): RuleDraft => {
    const draft = blankRule(label, makeId());
    draft.rule = {
      ...draft.rule,
      conversationKinds: kinds,
      mentionsMe,
      fromSelf,
    };
    return draft;
  };
  return {
    name: "",
    enabled: true,
    sourceAccountId,
    rules: [
      rule(labels.direct, ["direct"], "any", "no"),
      rule(labels.groupMention, ["group"], "yes", "no"),
      rule(labels.selfTest, ["direct"], "any", "yes"),
    ],
    guide: "",
    sessionKey: "conversation",
    access: "direct",
    inheritOtherConnectors: true,
    limits: {
      perHour: channelBounds.perHour.initial,
      perDay: channelBounds.perDay.initial,
      concurrency: channelBounds.concurrency.initial,
    },
  };
}

export function sourceAccessOf(
  scope: MessageChannelConnectorScope | undefined,
): SourceAccess {
  if (!scope || scope.level !== "write") return "read";
  return scope.writes === "direct" ? "direct" : "confirm";
}

function sourceScope(
  accountId: string,
  access: SourceAccess,
): MessageChannelConnectorScope {
  return {
    accountId,
    level: access === "read" ? "read" : "write",
    writes: access === "direct" ? "direct" : "confirm",
  };
}

export function draftFromChannel(channel: MessageChannel): ChannelDraft {
  const accountId = channel.source.accountId;
  return {
    name: channel.name,
    enabled: channel.enabled,
    sourceAccountId: accountId,
    rules: channel.filters.rules.map((rule) => ({
      rule,
      prefixes: rule.textPrefixes.join(" "),
      conversationIds: (rule.conversationIds ?? []).join("\n"),
    })),
    guide: channel.guide,
    sessionKey: channel.sessionKey === "thread" ? "thread" : "conversation",
    access: sourceAccessOf(
      channel.scope.connectors.find((entry) => entry.accountId === accountId),
    ),
    inheritOtherConnectors: channel.scope.connectorDefault !== "off",
    limits: { ...channel.limits },
  };
}

/** Prefixes as typed: separated by spaces or commas. */
export function parsePrefixes(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).filter(Boolean))];
}

/** Conversation ids as typed: one per line. */
export function parseLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The input the server takes. Editing keeps the scope entries of connectors
 * other than the source as they were.
 */
export function channelInput(
  draft: ChannelDraft,
  sources: readonly MessageChannelSource[],
  previous?: MessageChannel,
): MessageChannelInput {
  const accountId = draft.sourceAccountId;
  const source = sources.find((entry) => entry.accountId === accountId) ??
    (previous?.source.accountId === accountId
      ? previous.source
      : undefined) ?? {
      kind: "",
      accountId,
    };
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    source,
    filters: {
      rules: draft.rules.map(({ rule, prefixes, conversationIds }) => {
        const ids = parseLines(conversationIds);
        const next: MessageChannelRule = {
          ...rule,
          label: rule.label?.trim() ?? "",
          textPrefixes: parsePrefixes(prefixes),
        };
        if (ids.length) next.conversationIds = ids;
        else delete next.conversationIds;
        return next;
      }),
    },
    guide: draft.guide,
    sessionKey: draft.sessionKey,
    scope: {
      connectorDefault: draft.inheritOtherConnectors ? "inherit" : "off",
      connectors: [
        ...(previous?.scope.connectors ?? []).filter(
          (entry) => entry.accountId !== accountId,
        ),
        ...(accountId ? [sourceScope(accountId, draft.access)] : []),
      ],
      workspaces: { scope: "all", include: [], exclude: [] },
      identityResources: [],
    },
    limits: { ...draft.limits },
  };
}

export type ChannelProblem =
  | { kind: "name" }
  | { kind: "source" }
  | { kind: "guide" }
  | { kind: "tooManyRules" }
  | { kind: "noPrefix"; rule: number }
  | { kind: "tooManyPrefixes"; rule: number }
  | { kind: "longPrefix"; rule: number }
  | { kind: "noKinds"; rule: number }
  | { kind: "limit"; key: ChannelLimitKey; min: number; max: number };

/** What keeps the draft from being saved; empty when it may be. */
export function channelProblems(draft: ChannelDraft): ChannelProblem[] {
  const problems: ChannelProblem[] = [];
  const name = draft.name.trim();
  if (!name || name.length > channelBounds.name)
    problems.push({ kind: "name" });
  if (!draft.sourceAccountId) problems.push({ kind: "source" });
  if (draft.guide.length > channelBounds.guide)
    problems.push({ kind: "guide" });
  if (draft.rules.length > channelBounds.rules)
    problems.push({ kind: "tooManyRules" });
  draft.rules.forEach((entry, rule) => {
    const prefixes = parsePrefixes(entry.prefixes);
    if (entry.rule.enabled && prefixes.length === 0)
      problems.push({ kind: "noPrefix", rule });
    if (prefixes.length > channelBounds.prefixes)
      problems.push({ kind: "tooManyPrefixes", rule });
    if (prefixes.some((prefix) => prefix.length > channelBounds.prefix))
      problems.push({ kind: "longPrefix", rule });
    if (entry.rule.enabled && entry.rule.conversationKinds.length === 0)
      problems.push({ kind: "noKinds", rule });
  });
  for (const key of channelLimitKeys) {
    const { min, max } = channelBounds[key];
    const value = draft.limits[key];
    if (!Number.isInteger(value) || value < min || value > max)
      problems.push({ kind: "limit", key, min, max });
  }
  return problems;
}

/** A message channel's turns reach the assistant through its inbox as "mc:…". */
export function isChannelInboxEntry(entry: PersonalAgentInboxEntry): boolean {
  return entry.channel.startsWith("mc:");
}

/**
 * The sessions that belong to message channels, which the person's own
 * conversation with the assistant leaves out.
 */
export function channelSessionIds(
  list: MessageChannelList | undefined,
  inbox: readonly PersonalAgentInboxEntry[] = [],
): Set<string> {
  const ids = new Set<string>();
  for (const view of list?.channels ?? [])
    for (const sessionId of view.sessionIds) ids.add(sessionId);
  for (const entry of inbox)
    if (entry.sessionId && isChannelInboxEntry(entry)) ids.add(entry.sessionId);
  return ids;
}

/** A saved channel as input again, e.g. to turn it on or off. */
export function inputFromChannel(
  channel: MessageChannel,
  patch: Partial<MessageChannelInput> = {},
): MessageChannelInput {
  return {
    name: channel.name,
    enabled: channel.enabled,
    source: channel.source,
    filters: channel.filters,
    guide: channel.guide,
    sessionKey: channel.sessionKey,
    scope: channel.scope,
    limits: channel.limits,
    ...patch,
  };
}
