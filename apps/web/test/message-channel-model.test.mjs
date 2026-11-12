// Message channels (DEV-203): the editor's template, its conversion to the
// server's input and back, and which sessions the home page leaves out.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const {
  channelInput,
  channelProblems,
  channelSessionIds,
  draftFromChannel,
  newChannelDraft,
  parsePrefixes,
} = await import("../src/features/personal-agent/channel-model.ts");
const { recentAssistantSessions } =
  await import("../src/features/personal-agent/assistant-model.ts");

const labels = { direct: "D", groupMention: "G", selfTest: "S" };
const source = { kind: "openlark", accountId: "acct_lark", label: "OpenLark" };

test("a new channel starts from three enabled rules with no prefix", () => {
  let n = 0;
  const draft = newChannelDraft(labels, "acct_lark", () => `r${++n}`);
  assert.deepEqual(
    draft.rules.map(({ rule, prefixes }) => [
      rule.id,
      rule.label,
      rule.enabled,
      rule.conversationKinds,
      rule.mentionsMe,
      rule.fromSelf,
      rule.textPrefixes,
      prefixes,
    ]),
    [
      ["r1", "D", true, ["direct"], "any", "no", [], ""],
      ["r2", "G", true, ["group"], "yes", "no", [], ""],
      ["r3", "S", true, ["direct"], "any", "yes", [], ""],
    ],
  );
  assert.equal(draft.access, "direct");
  assert.equal(draft.inheritOtherConnectors, true);
  assert.equal(draft.sessionKey, "conversation");
  assert.deepEqual(draft.limits, { perHour: 20, perDay: 100, concurrency: 3 });
  // Saving waits for the person's prefixes.
  draft.name = "Lark";
  assert.deepEqual(
    channelProblems(draft).map((problem) => [problem.kind, problem.rule]),
    [
      ["noPrefix", 0],
      ["noPrefix", 1],
      ["noPrefix", 2],
    ],
  );
  draft.rules = draft.rules.map((entry) => ({ ...entry, prefixes: "/ai" }));
  assert.deepEqual(channelProblems(draft), []);
});

test("the input maps access and keeps other connectors' scope", () => {
  const draft = newChannelDraft(labels, "acct_lark", () => "r");
  draft.name = "  Lark ";
  draft.rules = [
    {
      ...draft.rules[0],
      prefixes: "/ai, ？问 /ai",
      conversationIds: "oc_1\n\n oc_2 \n",
    },
  ];
  draft.access = "confirm";
  draft.inheritOtherConnectors = false;
  const previous = {
    source,
    scope: {
      connectors: [
        { accountId: "acct_mail", level: "read", writes: "confirm" },
        { accountId: "acct_lark", level: "read", writes: "confirm" },
      ],
    },
  };
  const input = channelInput(draft, [source], previous);
  assert.equal(input.name, "Lark");
  assert.deepEqual(input.source, source);
  assert.deepEqual(input.filters.rules[0].textPrefixes, ["/ai", "？问"]);
  assert.deepEqual(input.filters.rules[0].conversationIds, ["oc_1", "oc_2"]);
  assert.deepEqual(input.scope, {
    connectorDefault: "off",
    connectors: [
      { accountId: "acct_mail", level: "read", writes: "confirm" },
      { accountId: "acct_lark", level: "write", writes: "confirm" },
    ],
    workspaces: { scope: "all", include: [], exclude: [] },
    identityResources: [],
  });

  const back = draftFromChannel({
    ...input,
    id: "mc_1",
    assistantId: "asst",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(back.access, "confirm");
  assert.equal(back.inheritOtherConnectors, false);
  assert.equal(back.rules[0].prefixes, "/ai ？问");
  assert.equal(back.rules[0].conversationIds, "oc_1\noc_2");
  assert.deepEqual(parsePrefixes("a,b  a"), ["a", "b"]);
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
