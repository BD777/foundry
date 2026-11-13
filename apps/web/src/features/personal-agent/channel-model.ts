import type {
  MessageChannel,
  MessageChannelCapabilities,
  MessageChannelConnectorScope,
  MessageChannelInput,
  MessageChannelList,
  MessageChannelPeers,
  MessageChannelRule,
  MessageChannelSample,
  MessageChannelSessionRule,
  MessageChannelSource,
  MessageChannelTriState,
  MessageChannelVerdict,
  MessageConversationKind,
  PersonalAgentInboxEntry,
} from "@bd777/foundry-protocol";
import type { TFunction } from "i18next";

// Message channels (DEV-203): the editor's draft and its conversion to the
// server's MessageChannelInput (contracts/models/message_channels.yaml).
//
// The filter is edited as shared trigger words plus the places they apply
// in (each place one rule of a fixed shape), and custom rules for anything
// else. The server's matching: leading @name words and spaces are skipped,
// then the text must start with a trigger word, ignoring case; a trigger
// ending in an ASCII letter or digit must not run into another one.

type Translate = TFunction<"personalAgent">;

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
  resetCommands: 5,
  resetCommand: 40,
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

/**
 * A standard place a channel's trigger words apply in. "self" is the
 * person's own messages: their chat with themselves when the source tells it
 * apart, else their own direct messages. "self-direct" is that older shape
 * kept for saved channels on a source that now tells self chats apart.
 */
export type PlaceId =
  "direct" | "group-mention" | "group" | "channel" | "self" | "self-direct";
export const placeIds: readonly PlaceId[] = [
  "direct",
  "group-mention",
  "group",
  "channel",
  "self",
  "self-direct",
];

/** The filter as the editor holds it. */
export interface FilterDraft {
  /** Shared by the standard places. */
  triggers: string[];
  /** Places turned on; only those the source can tell apart are saved. */
  places: PlaceId[];
  /** Rules beyond the standard places, ids `custom-<n>`. */
  custom: MessageChannelRule[];
}

export interface ChannelDraft {
  name: string;
  enabled: boolean;
  /** The source's accountId; "" until one is chosen. */
  sourceAccountId: string;
  filter: FilterDraft;
  sessionKey: "conversation" | "thread";
  session: MessageChannelSessionRule;
  /** On create: a new workspace, or one the person works in. */
  workspace: { mode: "new" | "existing"; id: string };
  access: SourceAccess;
  inheritOtherConnectors: boolean;
  limits: Record<ChannelLimitKey, number>;
}

/** A source that does not say what it tells apart is taken to tell all. */
export function capabilitiesOf(
  source: MessageChannelSource | undefined,
): MessageChannelCapabilities {
  return (
    source?.capabilities ?? {
      conversationKinds: [],
      mentionsMe: true,
      fromSelf: true,
    }
  );
}

/** The places the source can tell apart, in display order. */
export function availablePlaces(
  capabilities: MessageChannelCapabilities,
): PlaceId[] {
  const kinds = capabilities.conversationKinds;
  const has = (kind: MessageConversationKind) =>
    kinds.length === 0
      ? kind === "direct" || kind === "group"
      : kinds.includes(kind);
  const places: PlaceId[] = [];
  if (has("direct")) places.push("direct");
  if (has("group"))
    places.push(capabilities.mentionsMe ? "group-mention" : "group");
  if (kinds.includes("channel")) places.push("channel");
  if (tellsSelfChats(capabilities) || (capabilities.fromSelf && has("direct")))
    places.push("self");
  return places;
}

/** Whether the source marks the person's chat with themselves. */
export function tellsSelfChats(
  capabilities: MessageChannelCapabilities,
): boolean {
  return capabilities.conversationKinds.includes("self");
}

/**
 * The places a saved rule is read as: those offered, plus the older
 * own-direct-messages shape on a source that now tells self chats apart.
 */
export function recognizedPlaces(
  capabilities: MessageChannelCapabilities,
): PlaceId[] {
  const places = availablePlaces(capabilities);
  if (
    tellsSelfChats(capabilities) &&
    capabilities.fromSelf &&
    capabilities.conversationKinds.includes("direct")
  )
    places.push("self-direct");
  return places;
}

/** The places the editor lists: those offered, and older ones still on. */
export function shownPlaces(
  capabilities: MessageChannelCapabilities,
  on: readonly PlaceId[],
): PlaceId[] {
  const offered = availablePlaces(capabilities);
  return recognizedPlaces(capabilities).filter(
    (place) => offered.includes(place) || on.includes(place),
  );
}

/** The copy key of a place: "self" reads as own direct messages where self chats aren't told apart. */
export function placeKey(
  place: PlaceId,
  capabilities: MessageChannelCapabilities,
): PlaceId {
  return place === "self" && !tellsSelfChats(capabilities)
    ? "self-direct"
    : place;
}

type RuleShape = Pick<
  MessageChannelRule,
  "conversationKinds" | "mentionsMe" | "fromSelf"
>;

export function placeShape(
  place: PlaceId,
  capabilities: MessageChannelCapabilities,
): RuleShape {
  const others: MessageChannelTriState = capabilities.fromSelf ? "no" : "any";
  switch (place) {
    case "direct":
      return {
        conversationKinds: ["direct"],
        mentionsMe: "any",
        fromSelf: others,
      };
    case "group-mention":
      return {
        conversationKinds: ["group"],
        mentionsMe: "yes",
        fromSelf: others,
      };
    case "group":
      return {
        conversationKinds: ["group"],
        mentionsMe: "any",
        fromSelf: others,
      };
    case "channel":
      return {
        conversationKinds: ["channel"],
        mentionsMe: "any",
        fromSelf: others,
      };
    case "self":
      return tellsSelfChats(capabilities)
        ? { conversationKinds: ["self"], mentionsMe: "any", fromSelf: "any" }
        : { conversationKinds: ["direct"], mentionsMe: "any", fromSelf: "yes" };
    case "self-direct":
      return {
        conversationKinds: ["direct"],
        mentionsMe: "any",
        fromSelf: "yes",
      };
  }
}

/** The place a sample stands for, to try the rules on. */
export function placeSample(
  place: PlaceId,
  text: string,
  capabilities?: MessageChannelCapabilities,
): MessageChannelSample {
  const own = place === "self" || place === "self-direct";
  return {
    text,
    conversationKind:
      place === "self" && capabilities && tellsSelfChats(capabilities)
        ? "self"
        : place === "direct" || own
          ? "direct"
          : place === "channel"
            ? "channel"
            : "group",
    mentionsMe: place === "group-mention",
    fromSelf: own,
  };
}

function hasLists(rule: MessageChannelRule): boolean {
  return Boolean(
    rule.conversationIds?.length ||
    rule.excludeConversationIds?.length ||
    rule.senderIds?.length ||
    rule.excludeSenderIds?.length,
  );
}

function sameShape(rule: MessageChannelRule, shape: RuleShape): boolean {
  return (
    rule.conversationKinds.length === shape.conversationKinds.length &&
    shape.conversationKinds.every((kind) =>
      rule.conversationKinds.includes(kind),
    ) &&
    rule.mentionsMe === shape.mentionsMe &&
    rule.fromSelf === shape.fromSelf &&
    !rule.caseSensitive &&
    !hasLists(rule)
  );
}

/** The standard place a rule's shape is, whatever its id and label. */
export function placeOfRule(
  rule: MessageChannelRule,
  capabilities: MessageChannelCapabilities,
): PlaceId | undefined {
  return recognizedPlaces(capabilities).find((place) =>
    sameShape(rule, placeShape(place, capabilities)),
  );
}

/** Trigger words as saved: trimmed, at most once each, ignoring case. */
export function cleanTriggers(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

function sameTriggers(a: readonly string[], b: readonly string[]): boolean {
  const left = cleanTriggers(a)
    .map((word) => word.toLowerCase())
    .sort();
  const right = cleanTriggers(b)
    .map((word) => word.toLowerCase())
    .sort();
  return (
    left.length === right.length && left.every((word, at) => word === right[at])
  );
}

function customId(n: number): string {
  return `custom-${n}`;
}

/** The next free custom rule id. */
export function nextCustomId(custom: readonly MessageChannelRule[]): string {
  let n = 0;
  for (const rule of custom) {
    const match = /^custom-(\d+)$/.exec(rule.id);
    if (match) n = Math.max(n, Number(match[1]));
  }
  return customId(n + 1);
}

/**
 * Saved rules as the editor's filter. Enabled standard-shaped rules that
 * share their trigger words become the shared triggers and places; if they
 * differ, they stay custom rules so nothing is lost. Disabled
 * standard-shaped rules are dropped (an off place says the same); every
 * other rule is a custom rule.
 */
export function filterFromRules(
  rules: readonly MessageChannelRule[],
  capabilities: MessageChannelCapabilities,
): FilterDraft {
  const placed = rules.map((rule) => placeOfRule(rule, capabilities));
  const standard = rules.filter((rule, at) => rule.enabled && placed[at]);
  const shared =
    standard.length > 0 &&
    standard.every((rule) =>
      sameTriggers(rule.textPrefixes, standard[0]!.textPrefixes),
    );
  const places: PlaceId[] = [];
  const custom: MessageChannelRule[] = [];
  rules.forEach((rule, at) => {
    const place = placed[at];
    if (place && !rule.enabled) return;
    if (place && shared) {
      if (!places.includes(place)) places.push(place);
      return;
    }
    custom.push({ ...rule, id: customId(custom.length + 1) });
  });
  return {
    triggers: shared ? cleanTriggers(standard[0]!.textPrefixes) : [],
    places: placeIds.filter((place) => places.includes(place)),
    custom,
  };
}

/** The places that become rules: on, and told apart by the source. */
export function activePlaces(
  filter: FilterDraft,
  capabilities: MessageChannelCapabilities,
): PlaceId[] {
  return recognizedPlaces(capabilities).filter((place) =>
    filter.places.includes(place),
  );
}

/** The filter as the server's rules: the places first, then custom ones. */
export function filterRules(
  filter: FilterDraft,
  capabilities: MessageChannelCapabilities,
  placeLabel: (place: PlaceId) => string = () => "",
): MessageChannelRule[] {
  const triggers = cleanTriggers(filter.triggers);
  return [
    ...activePlaces(filter, capabilities).map((place): MessageChannelRule => ({
      id: place,
      label: placeLabel(place),
      enabled: true,
      ...placeShape(place, capabilities),
      textPrefixes: [...triggers],
    })),
    ...filter.custom.map((rule) => {
      const next: MessageChannelRule = {
        ...rule,
        label: rule.label?.trim() ?? "",
        textPrefixes: cleanTriggers(rule.textPrefixes),
      };
      for (const key of [
        "conversationIds",
        "excludeConversationIds",
        "senderIds",
        "excludeSenderIds",
      ] as const)
        if (!next[key]?.length) delete next[key];
      return next;
    }),
  ];
}

/** The conversation kinds a custom rule can pick, plus any it already has. */
export function customKinds(
  capabilities: MessageChannelCapabilities,
  rule?: MessageChannelRule,
): MessageConversationKind[] {
  const offered: MessageConversationKind[] = capabilities.conversationKinds
    .length
    ? [...capabilities.conversationKinds]
    : ["direct", "group"];
  for (const kind of rule?.conversationKinds ?? [])
    if (!offered.includes(kind)) offered.push(kind);
  return offered;
}

/** A new custom rule: direct messages, with the shared trigger words. */
export function newCustomRule(
  filter: FilterDraft,
  capabilities: MessageChannelCapabilities,
): MessageChannelRule {
  return {
    id: nextCustomId(filter.custom),
    label: "",
    enabled: true,
    conversationKinds: [customKinds(capabilities)[0] ?? "direct"],
    mentionsMe: "any",
    fromSelf: capabilities.fromSelf ? "no" : "any",
    textPrefixes: cleanTriggers(filter.triggers),
  };
}

/**
 * A new channel: direct messages, group @me and the person's own messages
 * on, no trigger word filled in for them, each thread its own session, a
 * new session after 4 hours without messages, a new workspace, the source's
 * writes left to the assistant, other connectors as the assistant has them.
 */
export function newChannelDraft(sourceAccountId = ""): ChannelDraft {
  return {
    name: "",
    enabled: true,
    sourceAccountId,
    filter: {
      triggers: [],
      places: ["direct", "group-mention", "group", "self"],
      custom: [],
    },
    sessionKey: "thread",
    session: defaultSessionRule(),
    workspace: { mode: "new", id: "" },
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

/** The source a channel reads: the listed one, else the one it saved. */
export function sourceOf(
  accountId: string,
  sources: readonly MessageChannelSource[],
  previous?: MessageChannel,
): MessageChannelSource | undefined {
  return (
    sources.find((entry) => entry.accountId === accountId) ??
    (previous?.source.accountId === accountId ? previous.source : undefined)
  );
}

export function draftFromChannel(
  channel: MessageChannel,
  sources: readonly MessageChannelSource[] = [],
): ChannelDraft {
  const accountId = channel.source.accountId;
  return {
    name: channel.name,
    enabled: channel.enabled,
    sourceAccountId: accountId,
    filter: filterFromRules(
      channel.filters.rules,
      capabilitiesOf(sourceOf(accountId, sources, channel)),
    ),
    sessionKey: channel.sessionKey === "thread" ? "thread" : "conversation",
    session: sessionRuleOf(channel),
    workspace: channel.workspaceId
      ? { mode: "existing", id: channel.workspaceId }
      : { mode: "new", id: "" },
    access: sourceAccessOf(
      channel.scope.connectors.find((entry) => entry.accountId === accountId),
    ),
    inheritOtherConnectors: channel.scope.connectorDefault !== "off",
    limits: { ...channel.limits },
  };
}

/**
 * The input the server takes. Editing keeps the scope entries of connectors
 * other than the source as they were, the workspace and the old guide text
 * (the workspace's AGENTS.md holds the instructions now).
 */
export function channelInput(
  draft: ChannelDraft,
  sources: readonly MessageChannelSource[],
  previous?: MessageChannel,
  placeLabel?: (place: PlaceId) => string,
): MessageChannelInput {
  const accountId = draft.sourceAccountId;
  const found = sourceOf(accountId, sources, previous);
  const source = found ?? { kind: "", accountId };
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    source,
    filters: {
      rules: filterRules(draft.filter, capabilitiesOf(found), placeLabel),
    },
    guide: previous?.guide ?? "",
    sessionKey: draft.sessionKey,
    session: {
      idleMinutes: draft.session.idleMinutes,
      resetCommands: cleanTriggers(draft.session.resetCommands),
    },
    workspaceId: previous
      ? (previous.workspaceId ?? "")
      : draft.workspace.mode === "existing"
        ? draft.workspace.id
        : "",
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
  | { kind: "workspace" }
  | { kind: "idle" }
  | { kind: "resetCommands" }
  | { kind: "tooManyRules" }
  | { kind: "noTriggers" }
  | { kind: "noPlace" }
  | { kind: "customNoTrigger"; rule: number }
  | { kind: "customNoPlace"; rule: number }
  | { kind: "limit"; key: ChannelLimitKey; min: number; max: number };

/** What keeps the draft from being saved, in the editor's order; empty when it may be. */
export function channelProblems(
  draft: ChannelDraft,
  capabilities: MessageChannelCapabilities,
): ChannelProblem[] {
  const problems: ChannelProblem[] = [];
  const name = draft.name.trim();
  if (!name || name.length > channelBounds.name)
    problems.push({ kind: "name" });
  if (!draft.sourceAccountId) problems.push({ kind: "source" });
  if (draft.workspace.mode === "existing" && !draft.workspace.id)
    problems.push({ kind: "workspace" });
  const { filter } = draft;
  const places = activePlaces(filter, capabilities);
  if (places.length && cleanTriggers(filter.triggers).length === 0)
    problems.push({ kind: "noTriggers" });
  if (!places.length && !filter.custom.some((rule) => rule.enabled))
    problems.push({ kind: "noPlace" });
  filter.custom.forEach((rule, at) => {
    if (!rule.enabled) return;
    if (rule.conversationKinds.length === 0)
      problems.push({ kind: "customNoPlace", rule: at });
    if (cleanTriggers(rule.textPrefixes).length === 0)
      problems.push({ kind: "customNoTrigger", rule: at });
  });
  if (places.length + filter.custom.length > channelBounds.rules)
    problems.push({ kind: "tooManyRules" });
  if (!idleChoices.includes(draft.session.idleMinutes))
    problems.push({ kind: "idle" });
  if (!resetCommandsValid(draft.session.resetCommands))
    problems.push({ kind: "resetCommands" });
  for (const key of channelLimitKeys) {
    const { min, max } = channelBounds[key];
    const value = draft.limits[key];
    if (!Number.isInteger(value) || value < min || value > max)
      problems.push({ kind: "limit", key, min, max });
  }
  return problems;
}

export function problemText(problem: ChannelProblem, t: Translate): string {
  if (problem.kind === "limit")
    return t("settings.channels.editor.problems.limit", {
      label: t(`settings.channels.editor.limits.${problem.key}`),
      min: problem.min,
      max: problem.max,
    });
  return t(`settings.channels.editor.problems.${problem.kind}`);
}

/** Names conversations and senders by id; falls back to the id. */
export type PeerNames = (
  list: "conversations" | "senders",
  id: string,
) => string;

export function peerNames(peers?: MessageChannelPeers): PeerNames {
  return (list, id) => peers?.[list].find((peer) => peer.id === id)?.name || id;
}

function orList(words: readonly string[], t: Translate): string {
  return words.join(t("settings.channels.editor.sentence.or"));
}

function namedList(
  ids: readonly string[],
  list: "conversations" | "senders",
  names: PeerNames,
  t: Translate,
): string {
  const shown = ids
    .slice(0, 2)
    .map((id) =>
      t("settings.channels.editor.sentence.quoted", { name: names(list, id) }),
    )
    .join(t("settings.channels.editor.sentence.and"));
  return ids.length > 2
    ? t("settings.channels.editor.sentence.more", {
        names: shown,
        count: ids.length - 2,
      })
    : shown;
}

/**
 * One rule as a sentence: a standard place in its own words ("Direct
 * messages starting with /ai"), any other rule from its conditions.
 */
export function ruleSentence(
  rule: MessageChannelRule,
  capabilities: MessageChannelCapabilities,
  t: Translate,
  names: PeerNames = (_list, id) => id,
): string {
  const triggers = cleanTriggers(rule.textPrefixes);
  const place = placeOfRule(rule, capabilities);
  if (place)
    return triggers.length
      ? t(
          `settings.channels.editor.sentence.place.${placeKey(place, capabilities)}`,
          { triggers: orList(triggers, t) },
        )
      : t("settings.channels.editor.sentence.missing", {
          what: t(
            `settings.channels.editor.places.${placeKey(place, capabilities)}`,
          ),
        });
  const parts: string[] = [
    rule.conversationKinds.length
      ? t("settings.channels.editor.sentence.in", {
          places: rule.conversationKinds
            .map((kind) => t(`settings.channels.editor.sentence.kind.${kind}`))
            .join(t("settings.channels.editor.sentence.or")),
        })
      : t("settings.channels.editor.sentence.nowhere"),
  ];
  if (rule.mentionsMe !== "any")
    parts.push(
      t(`settings.channels.editor.sentence.mention.${rule.mentionsMe}`),
    );
  if (rule.fromSelf !== "any")
    parts.push(t(`settings.channels.editor.sentence.self.${rule.fromSelf}`));
  const lists = [
    ["conversationIds", "conversations", "onlyIn"],
    ["excludeConversationIds", "conversations", "notIn"],
    ["senderIds", "senders", "onlyFrom"],
    ["excludeSenderIds", "senders", "notFrom"],
  ] as const;
  for (const [key, list, phrase] of lists) {
    const ids = rule[key] ?? [];
    if (ids.length)
      parts.push(
        t(`settings.channels.editor.sentence.${phrase}`, {
          names: namedList(ids, list, names, t),
        }),
      );
  }
  if (triggers.length)
    parts.push(
      t("settings.channels.editor.sentence.startsWith", {
        triggers: orList(triggers, t),
      }),
    );
  const joined = parts.join(t("settings.channels.editor.sentence.and"));
  return triggers.length
    ? t("settings.channels.editor.sentence.rule", { parts: joined })
    : t("settings.channels.editor.sentence.ruleMissing", { parts: joined });
}

/** Why a message failed a rule: the first condition it did not meet. */
export type MissCode =
  "place" | "mention" | "self" | "conversation" | "sender" | "trigger";
const missOrder: readonly MissCode[] = [
  "place",
  "mention",
  "self",
  "conversation",
  "sender",
  "trigger",
];

export type VerdictReading =
  | { keep: true; rule?: MessageChannelRule }
  | { keep: false; rule?: MessageChannelRule; miss: MissCode };

/**
 * A test verdict for the person: the rule that matched, or the rule that
 * came closest (its place matched and it failed latest) and why it missed.
 */
export function readVerdict(
  verdict: MessageChannelVerdict,
  rules: readonly MessageChannelRule[],
): VerdictReading {
  const ruleOf = (id?: string) => rules.find((rule) => rule.id === id);
  if (verdict.keep) return { keep: true, rule: ruleOf(verdict.rule) };
  let best: { ruleId: string; miss: MissCode } | undefined;
  for (const check of verdict.checks) {
    const miss = missOrder.includes(check.miss as MissCode)
      ? (check.miss as MissCode)
      : undefined;
    if (!miss) continue;
    if (!best || missOrder.indexOf(miss) > missOrder.indexOf(best.miss))
      best = { ruleId: check.ruleId, miss };
  }
  return best
    ? { keep: false, rule: ruleOf(best.ruleId), miss: best.miss }
    : { keep: false, miss: "place" };
}

/** The reason a verdict missed, in one plain phrase. */
export function missText(
  reading: Extract<VerdictReading, { keep: false }>,
  t: Translate,
): string {
  const { miss, rule } = reading;
  if (miss === "mention")
    return t(
      rule?.mentionsMe === "no"
        ? "settings.channels.editor.reasons.mentioned"
        : "settings.channels.editor.reasons.mention",
    );
  if (miss === "self")
    return t(
      rule?.fromSelf === "yes"
        ? "settings.channels.editor.reasons.notSelf"
        : "settings.channels.editor.reasons.self",
    );
  return t(`settings.channels.editor.reasons.${miss}`);
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
  for (const sessionId of list?.channelSessionIds ?? []) ids.add(sessionId);
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
    session: sessionRuleOf(channel),
    workspaceId: channel.workspaceId ?? "",
    scope: channel.scope,
    limits: channel.limits,
    ...patch,
  };
}

/** How long a conversation may be quiet before its next message starts a new session; 0 never. */
export const idleChoices: readonly number[] = [
  0, 30, 60, 240, 720, 1440, 4320, 10080,
];

export function defaultSessionRule(): MessageChannelSessionRule {
  return { idleMinutes: 240, resetCommands: [] };
}

/** A channel's session rule; a channel saved without one has the default. */
export function sessionRuleOf(channel: {
  session?: MessageChannelSessionRule;
}): MessageChannelSessionRule {
  return channel.session
    ? {
        idleMinutes: channel.session.idleMinutes,
        resetCommands: [...channel.session.resetCommands],
      }
    : defaultSessionRule();
}

/** At most five commands, each one word of at most 40 characters. */
export function resetCommandsValid(commands: readonly string[]): boolean {
  const clean = cleanTriggers(commands);
  return (
    clean.length <= channelBounds.resetCommands &&
    clean.every(
      (word) => word.length <= channelBounds.resetCommand && !/\s/.test(word),
    )
  );
}
