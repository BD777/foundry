// Regression tests for the cross-language contract guard. The parsers are
// exercised against inline fixtures (no source rewriting) plus the real
// checked-in sources, so a drifting vocabulary fails here as well as in
// `pnpm audit:contract`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  browserEventFailures,
  compareBrowserEvents,
  compareDaemonPayloads,
  compareDtoFields,
  compareMessageVocabularies,
  compareSessionClasses,
  compareSessionEventLabels,
  daemonPayloadFailures,
  findGoSessionClassLiterals,
  findGoEventLiterals,
  findGoLabelLiterals,
  goDtoPaths,
  goStructFields,
  parseGoBrowserEvents,
  parseGoMessageTypes,
  parseGoNotices,
  parseGoSessionClasses,
  parseGoSessionEventLabels,
  parseGoStructs,
  parseGoStructsWithEmbeds,
  parseTsBrowserEvents,
  parseTsInterfaces,
  parseTsMessageTypes,
  parseTsSessionClasses,
  parseTsSessionEventLabels,
  readMerged,
  sessionClassFailures,
  sessionEventLabelFailures,
  tsDtoPaths,
} from "../../../scripts/audit-contract.mjs";
import { daemonMessageTypes } from "../dist/index.js";

const root = resolve(import.meta.dirname, "../../..");

test("parseTsMessageTypes reads the const object values", () => {
  const source = `export const daemonMessageTypes = {
  ack: "ack",
  runSession: "run_session",
} as const;
`;
  assert.deepEqual([...parseTsMessageTypes(source)].sort(), [
    "ack",
    "run_session",
  ]);
});

test("parseGoMessageTypes reads ws*Type constant values", () => {
  const source = `const (
	wsAckType     = "ack"
	wsRunSessionType = "run_session"
	unrelatedConst = "ignored"
)
`;
  assert.deepEqual([...parseGoMessageTypes(source)].sort(), [
    "ack",
    "run_session",
  ]);
});

test("compareMessageVocabularies reports drift in both directions", () => {
  const problems = compareMessageVocabularies(
    new Set(["ack", "only_in_ts"]),
    new Set(["ack", "only_in_go"]),
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /declared in TS but not in Go.*only_in_ts/);
  assert.match(problems[1], /declared in Go.*but not in TS.*only_in_go/);
  assert.deepEqual(
    compareMessageVocabularies(new Set(["ack"]), new Set(["ack"])),
    [],
  );
});

test("compareDtoFields reports missing structs and field drift", () => {
  assert.match(
    compareDtoFields(new Map([["Widget", ["id"]]]), new Map())[0],
    /"Widget" has no matching Go struct/,
  );
  assert.match(
    compareDtoFields(
      new Map([["Widget", ["id", "tsOnly"]]]),
      new Map([["Widget", ["id", "goOnly"]]]),
    ).join(" | "),
    /missing in Go: tsOnly.*missing in TS: goOnly/,
  );
});

test("checked-in daemon vocabularies are in set parity", () => {
  const tsTypes = parseTsMessageTypes(
    readFileSync(
      resolve(root, "packages/protocol/src/daemon-messages.ts"),
      "utf8",
    ),
  );
  const goTypes = parseGoMessageTypes(
    readFileSync(
      resolve(root, "apps/server/internal/httpapi/daemon_wire.go"),
      "utf8",
    ),
  );
  assert.ok(tsTypes.size > 0, "expected TS message types to parse");
  assert.ok(goTypes.size > 0, "expected Go ws*Type constants to parse");
  assert.deepEqual(compareMessageVocabularies(tsTypes, goTypes), []);
  assert.deepEqual(
    [...tsTypes].sort(),
    Object.values(daemonMessageTypes).sort(),
    "parser output must match the runtime const object",
  );
});

test("checked-in DTOs are in field parity", () => {
  const tsInterfaces = readMerged(tsDtoPaths, parseTsInterfaces);
  const goStructs = readMerged(goDtoPaths, parseGoStructs);
  assert.ok(tsInterfaces.size > 0, "expected TS interfaces to parse");
  for (const name of ["ChatTitle", "WorkspaceFeishuBot", "ResyncPayload"])
    assert.ok(tsInterfaces.has(name), `expected ${name} among the DTOs`);
  assert.deepEqual(compareDtoFields(tsInterfaces, goStructs), []);
});

const tsBrowserEventsSource = `export const browserEventTypes = {
  // Issues.
  issueUpdated: "issue_updated",
  issueEnvironmentChanged: "issue_environment_changed",
} as const satisfies Record<string, keyof BrowserEventPayloads>;

export type BrowserEventPayloads = {
  issue_updated: Issue;
  issue_environment_changed: IssueEnvironmentChangedPayload;
};

export const browserNoticeTypes = [
  browserEventTypes.issueEnvironmentChanged,
] as const satisfies readonly BrowserEventType[];

export const browserStreamControlTypes = {
  resync: "resync",
} as const;

export type BrowserStreamControlPayloads = {
  resync: ResyncPayload;
};
`;

const goBrowserEventSource = `const (
	IssueUpdated            Type = "issue_updated"
	IssueEnvironmentChanged Type = "issue_environment_changed"
	// Resync tells a stream it missed events.
	Resync Type = "resync"
)

var payloadTypes = map[Type]reflect.Type{
	IssueUpdated:            reflect.TypeFor[store.Issue](),
	IssueEnvironmentChanged: reflect.TypeFor[IssueEnvironmentChangedPayload](),
	Resync:                  reflect.TypeFor[ResyncPayload](),
}

var notices = map[Type]bool{
	IssueEnvironmentChanged: true,
}
`;

test("browser event parsers read names, payload types and notices", () => {
  const ts = parseTsBrowserEvents(tsBrowserEventsSource);
  assert.deepEqual(
    [...ts.events],
    ["issue_updated", "issue_environment_changed"],
  );
  assert.deepEqual([...ts.controls], ["resync"]);
  assert.deepEqual(Object.fromEntries(ts.payloads), {
    issue_updated: "Issue",
    issue_environment_changed: "IssueEnvironmentChangedPayload",
    resync: "ResyncPayload",
  });
  assert.deepEqual([...ts.notices], ["issue_environment_changed"]);

  const go = parseGoBrowserEvents(goBrowserEventSource);
  assert.deepEqual(Object.fromEntries(go.constants), {
    IssueUpdated: "issue_updated",
    IssueEnvironmentChanged: "issue_environment_changed",
    Resync: "resync",
  });
  assert.deepEqual(Object.fromEntries(go.payloads), {
    issue_updated: "Issue",
    issue_environment_changed: "IssueEnvironmentChangedPayload",
    resync: "ResyncPayload",
  });
  const notices = parseGoNotices(goBrowserEventSource, go.constants);
  assert.deepEqual([...notices], ["issue_environment_changed"]);
  assert.deepEqual(compareBrowserEvents(ts, go, notices), []);
});

test("compareBrowserEvents reports name, payload and notice drift", () => {
  const ts = parseTsBrowserEvents(
    tsBrowserEventsSource
      .replace("issue_updated: Issue;", "issue_updated: IssueView;")
      .replace(
        `  resync: "resync",\n} as const;`,
        `  resync: "resync",\n  streamReady: "stream_ready",\n} as const;`,
      ),
  );
  const go = parseGoBrowserEvents(goBrowserEventSource);
  const problems = compareBrowserEvents(ts, go, new Set()).join(" | ");
  assert.match(
    problems,
    /in browser-events\.ts but not in package browserevent: stream_ready/,
  );
  assert.match(
    problems,
    /in browser-events\.ts names but not in browser-events\.ts payload maps: stream_ready/,
  );
  assert.match(
    problems,
    /notices in browserNoticeTypes but not in package browserevent notices: issue_environment_changed/,
  );
  assert.match(
    problems,
    /"issue_updated" carries IssueView in TS but Issue in Go/,
  );
});

test("findGoEventLiterals flags names spelled outside their constants", () => {
  const names = new Set(["issue_updated", "background_task_output_changed"]);
  const source = [
    `	s.events.Publish("issue_updated", issue)`,
    `	// "issue_updated" in a comment is fine`,
    '	Type string `json:"issue_updated"`',
    `	wsBackgroundTaskOutputChangedType = "background_task_output_changed"`,
    `	s.events.Publish(browserevent.IssueUpdated, issue)`,
  ].join("\n");
  assert.deepEqual(findGoEventLiterals(source, names), [
    { line: 1, name: "issue_updated" },
  ]);
});

test("checked-in browser event vocabularies are in parity", () => {
  const { failures, names } = browserEventFailures();
  assert.ok(names > 0, "expected browser event names to parse");
  assert.deepEqual(failures, []);
});

test("goStructFields folds embedded structs into the JSON fields", () => {
  const structs = parseGoStructsWithEmbeds(`type wsReplyError struct {
	Error string \`json:"error,omitempty"\`
}

type wsThingReadPayload struct {
	store.Thing
	wsReplyError
	Extra string \`json:"extra"\`
	Skipped string \`json:"-"\`
}

type Thing struct {
	ID string \`json:"id"\`
}
`);
  assert.deepEqual(goStructFields(structs, "wsThingReadPayload").sort(), [
    "error",
    "extra",
    "id",
  ]);
  assert.equal(goStructFields(structs, "wsMissing"), undefined);
});

test("compareDaemonPayloads maps names and reports new drift only", () => {
  const goStructs = new Map([
    ["wsReadThingPayload", { fields: ["id", "goOnly"], embeds: [] }],
    ["wsRenamed", { fields: ["id"], embeds: [] }],
  ]);
  const options = {
    goNames: { RenamedPayload: "wsRenamed" },
    builtInline: new Set(["InlinePayload"]),
    knownDrift: {},
  };
  const problems = compareDaemonPayloads(
    new Map([
      ["ReadThingPayload", ["id", "tsOnly"]],
      ["RenamedPayload", ["id"]],
      ["InlinePayload", ["anything"]],
      ["UnknownPayload", ["id"]],
    ]),
    goStructs,
    options,
  ).join(" | ");
  assert.match(
    problems,
    /"ReadThingPayload": fields in TS but not in Go wsReadThingPayload: \[tsOnly\]/,
  );
  assert.match(
    problems,
    /"ReadThingPayload": fields in Go wsReadThingPayload but not in TS: \[goOnly\]/,
  );
  assert.match(problems, /"UnknownPayload" has no Go struct wsUnknownPayload/);
  assert.doesNotMatch(problems, /RenamedPayload|InlinePayload/);
  assert.deepEqual(
    compareDaemonPayloads(
      new Map([["ReadThingPayload", ["id", "tsOnly"]]]),
      goStructs,
      {
        ...options,
        knownDrift: {
          ReadThingPayload: { tsOnly: ["tsOnly"], goOnly: ["goOnly"] },
        },
      },
    ),
    [],
  );
});

test("checked-in daemon request payloads are in field parity", () => {
  const { failures, compared } = daemonPayloadFailures();
  assert.ok(compared > 0, "expected daemon payload interfaces to parse");
  assert.deepEqual(failures, []);
});

test("session event label parsers pair keys, values and the turn-end set", () => {
  const ts = parseTsSessionEventLabels(
    `export const sessionEventLabels = {
  /** doc */
  responseStream: "Response stream",
  codexTurnEnd: "Codex finished",
} as const;
const turnEndLabels = new Set<string>([
  sessionEventLabels.codexTurnEnd,
]);`,
    `export const processLabels = {
  thinking: "Thinking",
  thought: "Thought",
} as const;
export const completedProcessLabelKeys: Partial<
  Record<ProcessLabelKey, ProcessLabelKey>
> = {
  thinking: "thought",
};`,
  );
  const go = parseGoSessionEventLabels(`const (
	EventLabelResponseStream = "Response stream"
	EventLabelCodexTurnEnd   = "Codex SDK finished"
	ProcessLabelThinking     = "Thinking"
	ProcessLabelThought      = "Thought"
)

var CompletedProcessLabels = map[string]string{
	ProcessLabelThinking: ProcessLabelThought,
}

func IsTurnEndLabel(label string) bool {
	switch label {
	case EventLabelCodexTurnEnd:
		return true
	}
	return false
}`);
  assert.deepEqual(compareSessionEventLabels(ts, go), [
    'session event label "codexTurnEnd" is "Codex finished" in protocol but "Codex SDK finished" in Go',
  ]);
  go.events.delete("responseStream");
  go.turnEnd.clear();
  assert.deepEqual(compareSessionEventLabels(ts, go), [
    "session event label in protocol but not in Go: responseStream",
    'session event label "codexTurnEnd" is "Codex finished" in protocol but "Codex SDK finished" in Go',
    "turn-end label in isTurnEndLabel but not in IsTurnEndLabel: codexTurnEnd",
  ]);
});

test("findGoLabelLiterals flags labels in Go strings and SQL", () => {
  const labels = new Set(["Response stream"]);
  const source = [
    `	if event.Label == "Response stream" {`,
    "	`SELECT 1 WHERE json_extract(payload_json, '$.label') = 'Response stream'`",
    `	// "Response stream" in a comment is fine`,
    `	if event.Label == store.EventLabelResponseStream {`,
  ].join("\n");
  assert.deepEqual(findGoLabelLiterals(source, labels), [
    { line: 1, label: "Response stream" },
    { line: 2, label: "Response stream" },
  ]);
});

test("checked-in session event labels are in parity", () => {
  const { failures, labels } = sessionEventLabelFailures();
  assert.ok(labels > 0, "expected session event labels to parse");
  assert.deepEqual(failures, []);
});

test("session class parsers pair sources and their classes", () => {
  const ts = parseTsSessionClasses(`export const sessionSources = {
  chat: "chat",
  naming: "naming",
  digest: "digest",
} as const;
export const activeSessionStatuses = ["queued", "running"] as const;
export const utilitySessionSources: readonly SessionSource[] = [
  sessionSources.naming,
  sessionSources.digest,
];
export const promptOnlySessionSources: readonly SessionSource[] = [
  sessionSources.naming,
];`);
  const go = parseGoSessionClasses(`const (
	SessionSourceChat   = "chat"
	SessionSourceNaming = "naming"
	SessionSourceDigest = "digests"
)
var ActiveSessionStatuses = []string{"queued", "running", "blocked"}
var UtilitySessionSources = []string{SessionSourceNaming, SessionSourceDigest}
var PromptOnlySessionSources = []string{SessionSourceNaming}`);
  assert.deepEqual(compareSessionClasses(ts, go), [
    'session source "digest" is "digest" in protocol but "digests" in Go',
    "active session status in ActiveSessionStatuses but not in activeSessionStatuses: blocked",
  ]);
});

test("findGoSessionClassLiterals flags re-spelled active sets and source literals", () => {
  const active = new Set(["queued", "running", "blocked"]);
  const sources = new Set(["chat", "naming", "digest"]);
  const source = [
    "	`SELECT id FROM agent_sessions WHERE status IN ('queued', 'running', 'blocked')`",
    `	return status == "queued" || status == "running" || status == "blocked"`,
    `	if session.Source == "naming" {`,
    "	`AND COALESCE(json_extract(payload_json, '$.source'), '') NOT IN ('digest', 'verification')`",
    "	`WHERE status IN ('running','blocked')`",
    `	if session.Source == store.SessionSourceNaming || item.Source == "foundry" {`,
  ].join("\n");
  assert.deepEqual(
    findGoSessionClassLiterals(source, active, sources).map(({ line }) => line),
    [1, 2, 3, 4],
  );
});

test("checked-in session classes are in parity", () => {
  const { failures, values } = sessionClassFailures();
  assert.ok(values > 0, "expected session classes to parse");
  assert.deepEqual(failures, []);
});
