// Message channels (DEV-203): the editor's filter (trigger words, places,
// custom rules) and its conversion to the server's input and back, rule
// sentences, test verdicts, and which sessions the home page leaves out.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const {
  availablePlaces,
  channelInput,
  channelProblems,
  channelSessionIds,
  draftFromChannel,
  filterFromRules,
  filterRules,
  inputFromChannel,
  missText,
  newChannelDraft,
  newCustomRule,
  placeKey,
  placeSample,
  problemText,
  readVerdict,
  ruleSentence,
  sessionRuleOf,
  shownPlaces,
} = await import("../src/features/personal-agent/channel-model.ts");
const {
  channelWorkspaceChoices,
  groupDeliveries,
  idleLabelParts,
  newSessionReason,
  revisionSource,
} = await import("../src/features/personal-agent/channel-session-model.ts");
const { recentAssistantSessions } =
  await import("../src/features/personal-agent/assistant-model.ts");

const full = { conversationKinds: [], mentionsMe: true, fromSelf: true };
const source = {
  kind: "chat",
  accountId: "acct_chat",
  label: "Team chat",
  capabilities: full,
};

// A stand-in for i18next's t: the key's last part with its values, so the
// tests read what a sentence is made of without the locale's wording.
function t(key, values = {}) {
  const name = key.replace("settings.channels.editor.", "");
  if (name === "sentence.or") return " | ";
  if (name === "sentence.and") return ", ";
  const args = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return args ? `${name}(${args})` : name;
}

const rule = (id, kinds, mentionsMe, fromSelf, textPrefixes, extra = {}) => ({
  id,
  label: "",
  enabled: true,
  conversationKinds: kinds,
  mentionsMe,
  fromSelf,
  textPrefixes,
  ...extra,
});

test("a new channel turns on the standard places, with no trigger word", () => {
  const draft = newChannelDraft("acct_chat");
  assert.deepEqual(draft.filter.triggers, []);
  assert.deepEqual(draft.filter.custom, []);
  assert.equal(draft.access, "direct");
  assert.equal(draft.inheritOtherConnectors, true);
  assert.equal(draft.sessionKey, "thread");
  assert.deepEqual(draft.session, { idleMinutes: 240, resetCommands: [] });
  assert.deepEqual(draft.workspace, { mode: "new", id: "" });
  assert.deepEqual(draft.limits, { perHour: 20, perDay: 100, concurrency: 3 });
  draft.name = "Chat";
  assert.deepEqual(channelProblems(draft, full), [{ kind: "noTriggers" }]);
  assert.equal(problemText({ kind: "noTriggers" }, t), "problems.noTriggers");
  draft.filter.triggers = ["/ai"];
  assert.deepEqual(channelProblems(draft, full), []);
  assert.deepEqual(
    filterRules(draft.filter, full, (place) => `L:${place}`).map((r) => [
      r.id,
      r.label,
      r.conversationKinds,
      r.mentionsMe,
      r.fromSelf,
      r.textPrefixes,
    ]),
    [
      ["direct", "L:direct", ["direct"], "any", "no", ["/ai"]],
      ["group-mention", "L:group-mention", ["group"], "yes", "no", ["/ai"]],
      ["self", "L:self", ["direct"], "any", "yes", ["/ai"]],
    ],
  );
});

test("places follow what the source can tell apart", () => {
  assert.deepEqual(availablePlaces(full), ["direct", "group-mention", "self"]);
  assert.deepEqual(
    availablePlaces({
      conversationKinds: ["group"],
      mentionsMe: false,
      fromSelf: false,
    }),
    ["group"],
  );
  assert.deepEqual(
    availablePlaces({
      conversationKinds: ["channel", "direct"],
      mentionsMe: false,
      fromSelf: true,
    }),
    ["direct", "channel", "self"],
  );
  // Without fromSelf, the places don't exclude the person's own messages.
  const caps = { conversationKinds: [], mentionsMe: false, fromSelf: false };
  const rules = filterRules(
    { triggers: ["/ai"], places: ["direct", "group", "self"], custom: [] },
    caps,
  );
  assert.deepEqual(
    rules.map((r) => [r.id, r.mentionsMe, r.fromSelf]),
    [
      ["direct", "any", "any"],
      ["group", "any", "any"],
    ],
  );
  assert.deepEqual(placeSample("group-mention", "hi"), {
    text: "hi",
    conversationKind: "group",
    mentionsMe: true,
    fromSelf: false,
  });
  assert.deepEqual(placeSample("self", "x").fromSelf, true);
});

test("legacy rules with the same prefixes become shared triggers and places", () => {
  const legacy = [
    rule("rule_a", ["direct"], "any", "no", ["/ai", "/fd"], { label: "D" }),
    rule("rule_b", ["group"], "yes", "no", ["/fd", "/AI"]),
    rule("rule_c", ["direct"], "any", "yes", ["/ai", "/fd"]),
    rule("rule_d", ["group"], "any", "no", ["/x"], { enabled: false }),
  ];
  const filter = filterFromRules(legacy, full);
  assert.deepEqual(filter.triggers, ["/ai", "/fd"]);
  assert.deepEqual(filter.places, ["direct", "group-mention", "self"]);
  // The disabled rule is not a standard shape here (groups tell @me apart).
  assert.deepEqual(
    filter.custom.map((r) => [r.id, r.enabled, r.textPrefixes]),
    [["custom-1", false, ["/x"]]],
  );
});

test("differing prefixes keep the rules as custom ones", () => {
  const filter = filterFromRules(
    [
      rule("rule_a", ["direct"], "any", "no", ["/ai"]),
      rule("rule_b", ["group"], "yes", "no", ["/fd"]),
      rule("rule_c", ["direct"], "any", "yes", ["/ai"], { enabled: false }),
      rule("rule_d", ["group"], "yes", "no", ["/ai"], {
        conversationIds: ["oc_1"],
      }),
    ],
    full,
  );
  assert.deepEqual(filter.triggers, []);
  assert.deepEqual(filter.places, []);
  assert.deepEqual(
    filter.custom.map((r) => [r.id, r.textPrefixes, r.conversationIds]),
    [
      ["custom-1", ["/ai"], undefined],
      ["custom-2", ["/fd"], undefined],
      ["custom-3", ["/ai"], ["oc_1"]],
    ],
  );
  assert.equal(newCustomRule(filter, full).id, "custom-4");
});

test("the input round-trips and keeps other connectors' scope", () => {
  const draft = newChannelDraft("acct_chat");
  draft.name = "  Chat ";
  draft.filter = {
    triggers: [" /ai", "？问", "/AI"],
    places: ["direct"],
    custom: [
      rule("custom-1", ["group"], "any", "any", ["/ops"], {
        label: " ops ",
        conversationIds: ["oc_1"],
        senderIds: [],
      }),
    ],
  };
  draft.access = "confirm";
  draft.inheritOtherConnectors = false;
  const previous = {
    source,
    scope: {
      connectors: [
        { accountId: "acct_mail", level: "read", writes: "confirm" },
        { accountId: "acct_chat", level: "read", writes: "confirm" },
      ],
    },
  };
  const input = channelInput(draft, [source], previous);
  assert.equal(input.name, "Chat");
  assert.deepEqual(input.source, source);
  assert.deepEqual(input.filters.rules, [
    rule("direct", ["direct"], "any", "no", ["/ai", "？问"]),
    rule("custom-1", ["group"], "any", "any", ["/ops"], {
      label: "ops",
      conversationIds: ["oc_1"],
    }),
  ]);
  assert.deepEqual(input.scope, {
    connectorDefault: "off",
    connectors: [
      { accountId: "acct_mail", level: "read", writes: "confirm" },
      { accountId: "acct_chat", level: "write", writes: "confirm" },
    ],
    workspaces: { scope: "all", include: [], exclude: [] },
    identityResources: [],
  });

  const back = draftFromChannel(
    { ...input, id: "mc_1", assistantId: "asst", createdAt: "", updatedAt: "" },
    [source],
  );
  assert.equal(back.access, "confirm");
  assert.equal(back.inheritOtherConnectors, false);
  assert.deepEqual(back.filter.triggers, ["/ai", "？问"]);
  assert.deepEqual(back.filter.places, ["direct"]);
  assert.deepEqual(back.filter.custom, [input.filters.rules[1]]);
  assert.deepEqual(
    channelInput(back, [source], previous).filters.rules,
    input.filters.rules,
  );
});

test("rules read as sentences", () => {
  assert.equal(
    ruleSentence(
      rule("direct", ["direct"], "any", "no", ["/ai", "/fd"]),
      full,
      t,
    ),
    "sentence.place.direct(triggers=/ai | /fd)",
  );
  assert.equal(
    ruleSentence(rule("x", ["group"], "yes", "no", []), full, t),
    "sentence.missing(what=places.group-mention)",
  );
  const names = (list, id) => (id === "oc_1" ? "Ops" : id);
  assert.equal(
    ruleSentence(
      rule("custom-1", ["direct", "group"], "yes", "any", ["/ai"], {
        conversationIds: ["oc_1", "oc_2", "oc_3"],
        excludeSenderIds: ["u_1"],
      }),
      full,
      t,
      names,
    ),
    "sentence.rule(parts=sentence.in(places=sentence.kind.direct | sentence.kind.group), sentence.mention.yes, sentence.onlyIn(names=sentence.more(names=sentence.quoted(name=Ops), sentence.quoted(name=oc_2);count=1)), sentence.notFrom(names=sentence.quoted(name=u_1)), sentence.startsWith(triggers=/ai))",
  );
  assert.equal(
    ruleSentence(rule("custom-2", [], "any", "any", []), full, t),
    "sentence.ruleMissing(parts=sentence.nowhere)",
  );
});

test("validation names what is missing, where it is", () => {
  const draft = newChannelDraft("");
  draft.filter = {
    triggers: [],
    places: [],
    custom: [
      rule("custom-1", [], "any", "any", []),
      rule("custom-2", ["direct"], "any", "any", [], { enabled: false }),
    ],
  };
  draft.limits.perHour = 0;
  assert.deepEqual(channelProblems(draft, full), [
    { kind: "name" },
    { kind: "source" },
    { kind: "customNoPlace", rule: 0 },
    { kind: "customNoTrigger", rule: 0 },
    { kind: "limit", key: "perHour", min: 1, max: 1000 },
  ]);
  draft.filter.custom = [];
  assert.deepEqual(
    channelProblems(draft, full).map((problem) => problem.kind),
    ["name", "source", "noPlace", "limit"],
  );
  // A place the source can't tell apart doesn't count.
  draft.filter.places = ["channel"];
  assert.ok(
    channelProblems(draft, full).some((problem) => problem.kind === "noPlace"),
  );
});

test("a verdict reads as the matched rule or the closest miss", () => {
  const rules = [
    rule("direct", ["direct"], "any", "no", ["/ai"]),
    rule("group-mention", ["group"], "yes", "no", ["/ai"]),
  ];
  const kept = readVerdict(
    { keep: true, rule: "direct", checks: [], envelope: {} },
    rules,
  );
  assert.deepEqual(kept, { keep: true, rule: rules[0] });
  const missed = readVerdict(
    {
      keep: false,
      envelope: {},
      checks: [
        { ruleId: "direct", miss: "place" },
        { ruleId: "group-mention", miss: "trigger" },
      ],
    },
    rules,
  );
  assert.deepEqual(missed, { keep: false, rule: rules[1], miss: "trigger" });
  assert.equal(missText(missed, t), "reasons.trigger");
  const self = readVerdict(
    {
      keep: false,
      envelope: {},
      checks: [{ ruleId: "direct", miss: "self" }],
    },
    rules,
  );
  assert.equal(missText(self, t), "reasons.self");
  assert.equal(
    missText({ keep: false, miss: "self", rule: { fromSelf: "yes" } }, t),
    "reasons.notSelf",
  );
  assert.deepEqual(readVerdict({ keep: false, envelope: {}, checks: [] }, []), {
    keep: false,
    miss: "place",
  });
});

test("channel sessions stay out of the person's conversation", () => {
  const ids = channelSessionIds(
    { channels: [{ sessionIds: ["sess_c1"] }], sources: [] },
    [
      { channel: "mc:mc_1:abc", sessionId: "sess_c2" },
      { channel: "web", sessionId: "sess_mine" },
    ],
  );
  assert.deepEqual([...ids].sort(), ["sess_c1", "sess_c2"]);
  const session = (id, at) => ({
    id,
    role: "personal_agent",
    startedAt: at,
  });
  const recent = recentAssistantSessions(
    [
      session("sess_mine", "2026-11-12T01:00:00Z"),
      session("sess_c1", "2026-11-12T02:00:00Z"),
      session("sess_c2", "2026-11-12T03:00:00Z"),
    ],
    3,
    ids,
  );
  assert.deepEqual(
    recent.map((entry) => entry.id),
    ["sess_mine"],
  );
});

const selfChats = {
  conversationKinds: ["direct", "self", "group"],
  mentionsMe: true,
  fromSelf: true,
};

test("a source that tells self chats apart gets the self-chat place", () => {
  assert.deepEqual(availablePlaces(selfChats), [
    "direct",
    "group-mention",
    "self",
  ]);
  const rules = filterRules(
    { triggers: ["/ai"], places: ["direct", "self"], custom: [] },
    selfChats,
  );
  assert.deepEqual(
    rules.map((r) => [r.id, r.conversationKinds, r.mentionsMe, r.fromSelf]),
    [
      ["direct", ["direct"], "any", "no"],
      ["self", ["self"], "any", "any"],
    ],
  );
  assert.equal(placeKey("self", selfChats), "self");
  assert.equal(placeKey("self", full), "self-direct");
  assert.deepEqual(placeSample("self", "x", selfChats), {
    text: "x",
    conversationKind: "self",
    mentionsMe: false,
    fromSelf: true,
  });
  assert.equal(placeSample("self", "x", full).conversationKind, "direct");
  assert.equal(
    ruleSentence(rules[1], selfChats, t),
    "sentence.place.self(triggers=/ai)",
  );
});

test("a saved own-direct-messages rule stays a place on a self-chat source", () => {
  const saved = [
    rule("direct", ["direct"], "any", "no", ["/ai"]),
    rule("self", ["direct"], "any", "yes", ["/ai"]),
  ];
  const filter = filterFromRules(saved, selfChats);
  assert.deepEqual(filter.places, ["direct", "self-direct"]);
  assert.deepEqual(filter.custom, []);
  assert.deepEqual(
    filterRules(filter, selfChats).map((r) => [
      r.id,
      r.conversationKinds,
      r.fromSelf,
    ]),
    [
      ["direct", ["direct"], "no"],
      ["self-direct", ["direct"], "yes"],
    ],
  );
  assert.equal(
    ruleSentence(saved[1], selfChats, t),
    "sentence.place.self-direct(triggers=/ai)",
  );
  // Listed while on; a new channel offers only the self chat.
  assert.deepEqual(shownPlaces(selfChats, filter.places), [
    "direct",
    "group-mention",
    "self",
    "self-direct",
  ]);
  assert.deepEqual(shownPlaces(selfChats, []), [
    "direct",
    "group-mention",
    "self",
  ]);
  // On a source without self chats the same rule is the "self" place.
  assert.deepEqual(filterFromRules(saved, full).places, ["direct", "self"]);
});

test("the session rule loads, validates and goes to the server", () => {
  assert.deepEqual(sessionRuleOf({}), { idleMinutes: 240, resetCommands: [] });
  const channel = {
    id: "mc_1",
    assistantId: "asst",
    name: "Chat",
    enabled: true,
    source,
    filters: { rules: [rule("direct", ["direct"], "any", "no", ["/ai"])] },
    guide: "old guide",
    sessionKey: "conversation",
    scope: {
      connectorDefault: "inherit",
      connectors: [],
      workspaces: { scope: "all", include: [], exclude: [] },
      identityResources: [],
    },
    limits: { perHour: 20, perDay: 100, concurrency: 3 },
    workspaceId: "ws_chan",
    createdAt: "",
    updatedAt: "",
  };
  const draft = draftFromChannel(channel, [source]);
  assert.equal(draft.sessionKey, "conversation");
  assert.deepEqual(draft.session, { idleMinutes: 240, resetCommands: [] });
  draft.session = { idleMinutes: 45, resetCommands: ["/new", "two words"] };
  assert.deepEqual(
    channelProblems(draft, full).map((problem) => problem.kind),
    ["idle", "resetCommands"],
  );
  draft.session = {
    idleMinutes: 0,
    resetCommands: [" /new", "/NEW", "/fresh"],
  };
  assert.deepEqual(channelProblems(draft, full), []);
  draft.session.resetCommands = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(
    channelProblems(draft, full).map((problem) => problem.kind),
    ["resetCommands"],
  );
  draft.session.resetCommands = ["/new", "/NEW"];
  const input = channelInput(draft, [source], channel);
  assert.deepEqual(input.session, { idleMinutes: 0, resetCommands: ["/new"] });
  // Editing keeps the workspace and the old guide text.
  assert.equal(input.workspaceId, "ws_chan");
  assert.equal(input.guide, "old guide");
  assert.equal(input.sessionKey, "conversation");
  const toggled = inputFromChannel(channel, { enabled: false });
  assert.deepEqual(toggled.session, { idleMinutes: 240, resetCommands: [] });
  assert.equal(toggled.workspaceId, "ws_chan");

  assert.deepEqual(idleLabelParts(0), { unit: "never", count: 0 });
  assert.deepEqual(idleLabelParts(30), { unit: "minutes", count: 30 });
  assert.deepEqual(idleLabelParts(240), { unit: "hours", count: 4 });
  assert.deepEqual(idleLabelParts(4320), { unit: "days", count: 3 });
});

test("a new channel creates its workspace or names one on the assistant's computer", () => {
  const draft = newChannelDraft("acct_chat");
  draft.name = "Chat";
  draft.filter.triggers = ["/ai"];
  assert.equal(channelInput(draft, [source]).workspaceId, "");
  assert.equal(channelInput(draft, [source]).guide, "");
  draft.workspace = { mode: "existing", id: "" };
  assert.deepEqual(
    channelProblems(draft, full).map((problem) => problem.kind),
    ["workspace"],
  );
  assert.equal(problemText({ kind: "workspace" }, t), "problems.workspace");
  draft.workspace.id = "ws_proj";
  assert.deepEqual(channelProblems(draft, full), []);
  assert.equal(channelInput(draft, [source]).workspaceId, "ws_proj");

  const ws = (id, extra = {}) => ({
    id,
    name: id,
    deviceId: "dev_home",
    ...extra,
  });
  assert.deepEqual(
    channelWorkspaceChoices(
      [
        ws("ws_b"),
        ws("ws_home"),
        ws("ws_a"),
        ws("ws_other", { deviceId: "dev_2" }),
        ws("ws_pa", { kind: "personal_agent" }),
        ws("ws_old", { archivedAt: "2026-01-01" }),
        ws("ws_view", { accessRole: "viewer" }),
        ws("ws_own", { accessRole: "owner" }),
      ],
      "dev_home",
      "ws_home",
    ).map((workspace) => workspace.id),
    ["ws_a", "ws_b", "ws_own"],
  );
  assert.deepEqual(channelWorkspaceChoices([ws("ws_a")], undefined, ""), []);
});

test("deliveries group by session, newest first", () => {
  const d = (id, at, extra = {}) => ({
    id,
    channelId: "mc_1",
    status: "done",
    createdAt: at,
    envelope: {
      id,
      kind: "message",
      op: "created",
      occurredAt: at,
      conversation: { id: "oc_1", kind: "group", name: "Ops" },
      sender: { id: "u_1" },
      mentionsMe: false,
      text: id,
    },
    ...extra,
  });
  const groups = groupDeliveries([
    d("m1", "2026-11-13T10:00:00Z", {
      sessionId: "s1",
      sessionKey: "oc_1",
      segment: 0,
      sessionNew: true,
      newReason: "first",
    }),
    d("m5", "2026-11-13T14:00:00Z", {
      status: "queued",
      sessionKey: "oc_1",
      segment: 1,
    }),
    d("m2", "2026-11-13T10:05:00Z", {
      sessionId: "s1",
      sessionKey: "oc_1",
      segment: 0,
    }),
    d("m3", "2026-11-13T13:00:00Z", {
      sessionId: "s2",
      sessionKey: "oc_1",
      segment: 1,
      sessionNew: true,
      newReason: "idle",
    }),
    d("m4", "2026-11-13T13:30:00Z", { status: "dropped" }),
    d("m6", "2026-11-13T12:00:00Z", {
      status: "queued",
      sessionKey: "oc_2",
      segment: 3,
    }),
    d("m7", "2026-11-13T11:00:00Z", {
      sessionId: "s3",
      sessionKey: "oc_2",
      segment: 2,
      sessionNew: true,
      newReason: "something new",
    }),
  ]);
  assert.deepEqual(
    groups.map((group) => [
      group.key,
      group.deliveries.map((delivery) => delivery.id),
      group.started,
      group.newReason,
      group.latest,
    ]),
    [
      ["session:s2", ["m5", "m3"], true, "idle", true],
      ["message:m4", ["m4"], false, undefined, false],
      ["segment:oc_2#3", ["m6"], false, undefined, true],
      ["session:s3", ["m7"], true, undefined, false],
      ["session:s1", ["m2", "m1"], true, "first", false],
    ],
  );
});

test("session reasons and revision sources read as known words", () => {
  assert.equal(newSessionReason("button"), "button");
  assert.equal(newSessionReason("restarted"), "restarted");
  assert.equal(newSessionReason("other"), undefined);
  assert.equal(newSessionReason(undefined), undefined);
  assert.equal(revisionSource("seed"), "seed");
  assert.equal(revisionSource("web"), "web");
  assert.equal(revisionSource("revert"), "revert");
  assert.equal(revisionSource("outside"), "outside");
  assert.equal(revisionSource("device"), "outside");
});
