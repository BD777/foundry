#!/usr/bin/env node
// Cross-language contract guard. Independent mechanical checks:
//
//   1. DTO field parity — for every TS interface in the protocol sources
//      below a Go struct with the same name must exist in the Go sources
//      below, and their JSON field names must match (TS field name == Go
//      `json:"..."` tag).
//
//   2. Daemon message vocabulary set parity — the string values in
//      packages/protocol/src/daemon-messages.ts must be exactly the set of
//      `ws*Type` constant values in apps/server/internal/httpapi/daemon_wire.go.
//
//   3. Browser event vocabulary (GET /api/events) — the `Type` constants of
//      apps/server/internal/browserevent and the names in
//      packages/protocol/src/browser-events.ts (browserEventTypes,
//      browserStreamControlTypes) are the same set; every name has a payload
//      on each side and both sides name the same payload type; the notices
//      (browserNoticeTypes) are exactly the ones package browserevent declares
//      (its notices set); and no other Go source spells an event name as a
//      string literal instead of using its constant.
//
//   4. Daemon request payload parity — every interface in
//      packages/protocol/src/daemon-messages.ts has a Go struct in
//      apps/server/internal/httpapi (`ws<Name>`, or the name in
//      daemonPayloadGoNames) with the same JSON field names, embedded structs
//      (wsReplyError, store.X) included. Payloads Go builds inline, with no
//      named struct, are listed in daemonPayloadsBuiltInline; fields one side
//      knows and the other deliberately does not are listed in
//      daemonPayloadKnownDrift, so any new drift still fails.
//
//   5. Session event labels — apps/server/internal/store/
//      session_event_labels.go mirrors packages/protocol/src/
//      session-events.ts and process-labels.ts: an `EventLabel<Key>` constant
//      for every sessionEventLabels key and a `ProcessLabel<Key>` for every
//      processLabels key, with the same values; CompletedProcessLabels is
//      completedProcessLabelKeys and IsTurnEndLabel names the turn-end
//      labels isTurnEndLabel does; TranscriptHiddenProcessLabels and
//      HeartbeatProcessLabels (what the event compaction relies on of the
//      transcript) are transcriptHiddenProcessLabelKeys and
//      heartbeatProcessLabelKeys. No other Go source spells a session event
//      label as a literal (SQL included) instead of using its constant.
//
//   6. Session classes — apps/server/internal/store/session_classes.go
//      mirrors packages/protocol/src/session-classes.ts: a
//      `SessionSource<Key>` constant for every sessionSources key with the
//      same value, and the same active statuses, utility sources and
//      prompt-only sources. No other Go source re-spells the active statuses
//      (an SQL list or a Go condition naming all of them) or compares a
//      session source with a literal (Go `.Source == "…"` or SQL on
//      `'$.source'`).
//
// The checks compare names, literal sets and JSON field names only. They do
// not validate field types, envelope direction, or handler coverage; the
// shared fixtures (packages/protocol/test/browser-event-fixtures.json) check
// browser event payloads by example on both sides.
//
// Usage: node scripts/audit-contract.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const tsDtoPaths = [
  "packages/protocol/src/chat.ts",
  "packages/protocol/src/device.ts",
  "packages/protocol/src/device-sharing.ts",
  "packages/protocol/src/device-placement.ts",
  "packages/protocol/src/foundry-data.ts",
  "packages/protocol/src/issue.ts",
  "packages/protocol/src/profiles.ts",
  "packages/protocol/src/session.ts",
  "packages/protocol/src/session-panel.ts",
  "packages/protocol/src/session-work.ts",
  "packages/protocol/src/service-tunnels.ts",
  "packages/protocol/src/skills.ts",
  "packages/protocol/src/workspace-draft-skills.ts",
  "packages/protocol/src/workspace.ts",
  "packages/protocol/src/feishu.ts",
  "packages/protocol/src/external-accounts.ts",
  "packages/protocol/src/connectors.ts",
  "packages/protocol/src/browser-events.ts",
  "packages/protocol/src/resources.ts",
  "packages/protocol/src/personal-agent.ts",
  "packages/protocol/src/personal-agent-list.ts",
  "packages/protocol/src/personal-agent-inbox.ts",
  "packages/protocol/src/personal-agent-runtime.ts",
  "packages/protocol/src/personal-agent-operation.ts",
  "packages/protocol/src/personal-agent-maintenance.ts",
  "packages/protocol/src/knowledge.ts",
  "packages/protocol/src/knowledge-vault.ts",
].map((path) => resolve(root, path));
export const goDtoPaths = [
  "apps/server/internal/store/workspaces.go",
  "apps/server/internal/store/devices.go",
  "apps/server/internal/store/device_sharing.go",
  "apps/server/internal/store/device_placement.go",
  "apps/server/internal/store/profiles.go",
  "apps/server/internal/store/native_account_holds.go",
  "apps/server/internal/store/skills.go",
  "apps/server/internal/store/workspace_draft_skills.go",
  "apps/server/internal/store/skill_repositories.go",
  "apps/server/internal/store/sessions.go",
  "apps/server/internal/store/session_panel.go",
  "apps/server/internal/store/session_work.go",
  "apps/server/internal/store/service_tunnels.go",
  "apps/server/internal/store/session_files.go",
  "apps/server/internal/store/session_frames.go",
  "apps/server/internal/store/session_timers.go",
  "apps/server/internal/store/session_activity.go",
  "apps/server/internal/store/chats.go",
  "apps/server/internal/store/chat_archives.go",
  "apps/server/internal/store/issues.go",
  "apps/server/internal/store/projections.go",
  "apps/server/internal/store/feishu.go",
  "apps/server/internal/store/external_accounts.go",
  "apps/server/internal/store/device_connectors.go",
  "apps/server/internal/browserevent/payloads.go",
  "apps/server/internal/store/resources.go",
  "apps/server/internal/store/personal_agent.go",
  "apps/server/internal/store/personal_agent_list.go",
  "apps/server/internal/store/personal_agent_inbox.go",
  "apps/server/internal/store/personal_agent_runtime.go",
  "apps/server/internal/store/personal_agent_maintenance.go",
  "apps/server/internal/store/personal_agent_run_control.go",
  "apps/server/internal/store/personal_agent_operation.go",
  "apps/server/internal/store/knowledge.go",
  "apps/server/internal/store/knowledge_vault.go",
  "apps/server/internal/store/knowledge_entries.go",
  "apps/server/internal/store/knowledge_publications.go",
  "apps/server/internal/store/knowledge_migrations.go",
  "apps/server/internal/store/knowledge_replica_cleanup.go",
].map((path) => resolve(root, path));
const tsMessagesPath = resolve(
  root,
  "packages/protocol/src/daemon-messages.ts",
);
const goMessagesPath = resolve(
  root,
  "apps/server/internal/httpapi/daemon_wire.go",
);
const goWireDir = resolve(root, "apps/server/internal/httpapi");
const goStoreDir = resolve(root, "apps/server/internal/store");

/** daemon-messages.ts interface -> its Go struct, where not `ws<Name>`. */
export const daemonPayloadGoNames = {
  DaemonAgentProfileInput: "CreateAgentProfileInput",
  FetchSkillRepositoryPayload: "wsFetchSkillRepository",
  ReadRepositoryRefsPayload: "wsReadRepositoryRefs",
  RunRepairPayload: "wsRunRepair",
};

/** Payloads Go marshals from an anonymous struct or map: nothing to compare. */
export const daemonPayloadsBuiltInline = new Set([
  // workspace_availability.go decodes it into an anonymous struct.
  "WorkspaceFoldersPayload",
]);

/**
 * Field names one side has on purpose. `goOnly`: the server sends them, the
 * worker does not read them. Listed so the audit still fails on new drift.
 */
export const daemonPayloadKnownDrift = {
  // The server's profile input also carries a models list, a command and an
  // env; the worker's profile upsert and catalog read take neither.
  DaemonAgentProfileInput: { goOnly: ["command", "env", "models"] },
};

const tsBrowserEventsPath = resolve(
  root,
  "packages/protocol/src/browser-events.ts",
);
const goBrowserEventDir = resolve(root, "apps/server/internal/browserevent");
const goServerDir = resolve(root, "apps/server/internal");

// --- Parse TS interfaces -------------------------------------------------

/** @returns {Map<string, string[]>} interface name -> field names */
export function parseTsInterfaces(source) {
  const interfaces = new Map();
  const re = /export\s+interface\s+(\w+)\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const [, name, body] = match;
    const fields = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      // field: type;  or  optionalField?: type;
      const fieldMatch = trimmed.match(/^(\w+)\??\s*:/);
      if (fieldMatch) fields.push(fieldMatch[1]);
    }
    interfaces.set(name, fields);
  }
  return interfaces;
}

// --- Parse Go structs ----------------------------------------------------

/** @returns {Map<string, string[]>} struct name -> JSON field names */
export function parseGoStructs(source) {
  const structs = new Map();
  const re = /^type\s+(\w+)\s+struct\s*\{([^}]*)\}/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    const [, name, body] = match;
    const fields = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      // FieldName Type `json:"fieldName,omitempty"`
      const tagMatch = trimmed.match(/`json:"([^",]+)/);
      // json:"-" is never serialized, so it is not part of the contract.
      if (tagMatch && tagMatch[1] !== "-") fields.push(tagMatch[1]);
    }
    structs.set(name, fields);
  }
  return structs;
}

// --- Parse daemon message vocabularies -----------------------------------

/**
 * Reads the string values of the `daemonMessageTypes` const object.
 * @returns {Set<string>} wire message type values
 */
export function parseTsMessageTypes(source) {
  return new Set(parseTsConstObject(source, "daemonMessageTypes").values());
}

/**
 * Reads a `export const <name> = { key: "value", … }` object.
 * @returns {Map<string, string>} key -> string value
 */
export function parseTsConstObject(source, name) {
  const block = source.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  const entries = new Map();
  if (!block) return entries;
  const re = /^\s*(\w+)\s*:\s*"([^"]+)"\s*,?\s*$/gm;
  let match;
  while ((match = re.exec(block[1])) !== null) entries.set(match[1], match[2]);
  return entries;
}

/**
 * Reads the string values of the Go `ws*Type` envelope constants.
 * @returns {Set<string>} wire message type values
 */
export function parseGoMessageTypes(source) {
  const values = new Set();
  const re = /^\s*(ws\w*Type)\s*=\s*"([^"]+)"\s*$/gm;
  let match;
  while ((match = re.exec(source)) !== null) values.add(match[2]);
  return values;
}

/**
 * Set-parity comparison of the two vocabularies.
 * @returns {string[]} failure descriptions, empty when the sets match
 */
export function compareMessageVocabularies(tsTypes, goTypes) {
  const problems = [];
  const missingInGo = [...tsTypes].filter((t) => !goTypes.has(t)).sort();
  const missingInTs = [...goTypes].filter((t) => !tsTypes.has(t)).sort();
  if (missingInGo.length > 0) {
    problems.push(
      `daemon message types declared in TS but not in Go daemon_wire.go: ${missingInGo.join(", ")}`,
    );
  }
  if (missingInTs.length > 0) {
    problems.push(
      `daemon message types declared in Go daemon_wire.go but not in TS: ${missingInTs.join(", ")}`,
    );
  }
  return problems;
}

// --- Browser event vocabulary --------------------------------------------

/**
 * Reads a `export type <name> = { key: TypeName; … };` map.
 * @returns {Map<string, string>} key -> type name
 */
export function parseTsTypeMap(source, name) {
  const block = source.match(
    new RegExp(`export\\s+type\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  const entries = new Map();
  if (!block) return entries;
  for (const [, key, type] of block[1].matchAll(/^\s*(\w+)\s*:\s*(\w+)\s*;/gm))
    entries.set(key, type);
  return entries;
}

/**
 * Reads browser-events.ts: event names, stream control names, the payload
 * type name of each, and the notices.
 */
export function parseTsBrowserEvents(source) {
  const events = parseTsConstObject(source, "browserEventTypes");
  const controls = parseTsConstObject(source, "browserStreamControlTypes");
  const payloads = new Map([
    ...parseTsTypeMap(source, "BrowserEventPayloads"),
    ...parseTsTypeMap(source, "BrowserStreamControlPayloads"),
  ]);
  const notices = new Set();
  const noticeList = source.match(
    /export\s+const\s+browserNoticeTypes\s*=\s*\[([\s\S]*?)\]/,
  );
  for (const [, key] of (noticeList?.[1] ?? "").matchAll(
    /browserEventTypes\.(\w+)/g,
  ))
    notices.add(events.get(key) ?? `browserEventTypes.${key}`);
  return {
    events: new Set(events.values()),
    controls: new Set(controls.values()),
    payloads,
    notices,
  };
}

/**
 * Reads package browserevent: its `Type` constants and the payload type
 * each name's payloadTypes entry registers.
 * @returns {{ constants: Map<string, string>, payloads: Map<string, string> }}
 *   constant -> wire name; wire name -> payload type name
 */
export function parseGoBrowserEvents(source) {
  const constants = new Map();
  for (const [, constant, wire] of source.matchAll(
    /^\s*(\w+)\s+Type\s*=\s*"([^"]+)"/gm,
  ))
    constants.set(constant, wire);
  const payloads = new Map();
  const registry = source.match(
    /var\s+payloadTypes\s*=\s*map\[Type\]reflect\.Type\s*\{([\s\S]*?)\n\}/,
  );
  for (const [, constant, type] of (registry?.[1] ?? "").matchAll(
    /^\s*(\w+)\s*:\s*reflect\.TypeFor\[\*?(?:\w+\.)?(\w+)\]\(\)/gm,
  ))
    payloads.set(constants.get(constant) ?? `browserevent.${constant}`, type);
  return { constants, payloads };
}

/**
 * The notices package browserevent declares: its `notices` set
 * (var notices = map[Type]bool{ X: true, … }).
 * @returns {Set<string>} wire names
 */
export function parseGoNotices(source, constants) {
  const notices = new Set();
  const declared = source.match(
    /var\s+notices\s*=\s*map\[Type\]bool\s*\{([\s\S]*?)\n\}/,
  );
  for (const [, constant] of (declared?.[1] ?? "").matchAll(
    /^\s*(\w+)\s*:\s*true\s*,/gm,
  ))
    notices.add(constants.get(constant) ?? `browserevent.${constant}`);
  return notices;
}

/**
 * Lines of a Go source that spell a browser event name as a string literal
 * (outside comments, struct tags and the daemon `ws*Type` constants, which
 * share two names).
 * @returns {{ line: number, name: string }[]}
 */
export function findGoEventLiterals(source, names) {
  const found = [];
  source.split("\n").forEach((text, index) => {
    if (/^\s*\/\//.test(text) || /^\s*ws\w*Type\s*=/.test(text)) return;
    const code = text.replace(/`[^`]*`/g, "");
    for (const [, name] of code.matchAll(/"([a-z_]+)"/g))
      if (names.has(name)) found.push({ line: index + 1, name });
  });
  return found;
}

function setDrift(label, left, leftName, right, rightName) {
  const problems = [];
  const onlyLeft = [...left].filter((name) => !right.has(name)).sort();
  const onlyRight = [...right].filter((name) => !left.has(name)).sort();
  if (onlyLeft.length > 0)
    problems.push(
      `${label} in ${leftName} but not in ${rightName}: ${onlyLeft.join(", ")}`,
    );
  if (onlyRight.length > 0)
    problems.push(
      `${label} in ${rightName} but not in ${leftName}: ${onlyRight.join(", ")}`,
    );
  return problems;
}

/**
 * Compares both sides of the browser event vocabulary.
 * @returns {string[]} failure descriptions, empty when they match
 */
export function compareBrowserEvents(ts, go, goNotices) {
  const tsNames = new Set([...ts.events, ...ts.controls]);
  const goNames = new Set(go.constants.values());
  const problems = [
    ...setDrift(
      "browser event names",
      tsNames,
      "browser-events.ts",
      goNames,
      "package browserevent",
    ),
    ...setDrift(
      "browser event names",
      tsNames,
      "browser-events.ts names",
      new Set(ts.payloads.keys()),
      "browser-events.ts payload maps",
    ),
    ...setDrift(
      "browser event names",
      goNames,
      "browserevent Type constants",
      new Set(go.payloads.keys()),
      "browserevent payloadTypes",
    ),
    ...setDrift(
      "browser notices",
      ts.notices,
      "browserNoticeTypes",
      goNotices,
      "package browserevent notices",
    ),
  ];
  for (const [name, tsType] of ts.payloads) {
    const goType = go.payloads.get(name);
    if (goType && goType !== tsType)
      problems.push(
        `browser event "${name}" carries ${tsType} in TS but ${goType} in Go`,
      );
  }
  return problems;
}

function goSources(dir, include) {
  const sources = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources.push(...goSources(path, include));
    else if (
      entry.name.endsWith(".go") &&
      !entry.name.endsWith("_test.go") &&
      include(path)
    )
      sources.push({ path, source: readFileSync(path, "utf8") });
  }
  return sources;
}

// --- Compare -------------------------------------------------------------

/** @returns {string[]} failure descriptions, empty when both guards pass */
export function compareDtoFields(tsInterfaces, goStructs) {
  const problems = [];
  for (const [name, tsFields] of tsInterfaces) {
    const goFields = goStructs.get(name);
    if (!goFields) {
      problems.push(`TS interface "${name}" has no matching Go struct`);
      continue;
    }
    const tsSet = new Set(tsFields);
    const goSet = new Set(goFields);
    const missingInGo = [...tsSet].filter((f) => !goSet.has(f));
    const missingInTs = [...goSet].filter((f) => !tsSet.has(f));
    if (missingInGo.length > 0) {
      problems.push(
        `"${name}": TS has fields missing in Go: ${missingInGo.join(", ")}`,
      );
    }
    if (missingInTs.length > 0) {
      problems.push(
        `"${name}": Go has fields missing in TS: ${missingInTs.join(", ")}`,
      );
    }
  }
  return problems;
}

// --- Daemon request payloads --------------------------------------------

/**
 * Go structs with their embedded structs (a field line with no name and no
 * json tag, such as `wsReplyError` or `store.AgentSubagentTranscript`).
 * @returns {Map<string, { fields: string[], embeds: string[] }>}
 */
export function parseGoStructsWithEmbeds(source) {
  const structs = new Map();
  const re = /^type\s+(\w+)\s+struct\s*\{([^}]*)\}/gm;
  for (const [, name, body] of source.matchAll(re)) {
    const fields = [];
    const embeds = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      const tagMatch = trimmed.match(/`json:"([^",]+)/);
      if (tagMatch) {
        if (tagMatch[1] !== "-") fields.push(tagMatch[1]);
        continue;
      }
      const embedMatch = trimmed.match(/^\*?(?:\w+\.)?(\w+)\s*(?:\/\/.*)?$/);
      if (embedMatch) embeds.push(embedMatch[1]);
    }
    structs.set(name, { fields, embeds });
  }
  return structs;
}

/**
 * A struct's JSON field names with its embedded structs' fields folded in.
 * @returns {string[] | undefined} undefined when the struct is unknown
 */
export function goStructFields(structs, name, seen = new Set()) {
  const struct = structs.get(name);
  if (!struct || seen.has(name)) return undefined;
  seen.add(name);
  const fields = [...struct.fields];
  for (const embed of struct.embeds)
    fields.push(...(goStructFields(structs, embed, seen) ?? []));
  return fields;
}

/**
 * Compares the daemon request payload interfaces with their Go structs.
 * @returns {string[]} failure descriptions, empty when they match
 */
export function compareDaemonPayloads(
  tsInterfaces,
  goStructs,
  {
    goNames = daemonPayloadGoNames,
    builtInline = daemonPayloadsBuiltInline,
    knownDrift = daemonPayloadKnownDrift,
  } = {},
) {
  const problems = [];
  for (const [name, tsFields] of tsInterfaces) {
    if (builtInline.has(name)) continue;
    const goName = goNames[name] ?? `ws${name}`;
    const goFields = goStructFields(goStructs, goName);
    if (!goFields) {
      problems.push(
        `daemon payload "${name}" has no Go struct ${goName} (map it in daemonPayloadGoNames, or list it in daemonPayloadsBuiltInline)`,
      );
      continue;
    }
    const drift = knownDrift[name] ?? {};
    const tsSet = new Set(tsFields);
    const goSet = new Set(goFields);
    const tsOnly = [...tsSet].filter((f) => !goSet.has(f)).sort();
    const goOnly = [...goSet].filter((f) => !tsSet.has(f)).sort();
    const expectTsOnly = [...(drift.tsOnly ?? [])].sort();
    const expectGoOnly = [...(drift.goOnly ?? [])].sort();
    if (tsOnly.join() !== expectTsOnly.join())
      problems.push(
        `daemon payload "${name}": fields in TS but not in Go ${goName}: [${tsOnly.join(", ")}]` +
          (expectTsOnly.length ? ` (known: [${expectTsOnly.join(", ")}])` : ""),
      );
    if (goOnly.join() !== expectGoOnly.join())
      problems.push(
        `daemon payload "${name}": fields in Go ${goName} but not in TS: [${goOnly.join(", ")}]` +
          (expectGoOnly.length ? ` (known: [${expectGoOnly.join(", ")}])` : ""),
      );
  }
  return problems;
}

/**
 * Checks the checked-in daemon request payloads (check 4).
 * @returns {{ failures: string[], compared: number }}
 */
export function daemonPayloadFailures() {
  const source = readFileSync(tsMessagesPath, "utf8");
  const tsInterfaces = parseTsInterfaces(source);
  const failures = [];
  const declared = [...source.matchAll(/export\s+interface\s+(\w+)/g)].map(
    ([, name]) => name,
  );
  const unread = declared.filter((name) => !tsInterfaces.has(name));
  if (unread.length > 0)
    failures.push(
      `daemon-messages.ts interfaces the audit cannot read (keep them flat, no extends): ${unread.join(", ")}`,
    );
  const goStructs = new Map();
  for (const dir of [goStoreDir, goWireDir])
    for (const { source: goSource } of goSources(dir, () => true))
      for (const [name, struct] of parseGoStructsWithEmbeds(goSource))
        goStructs.set(name, struct);
  for (const name of [
    ...Object.keys(daemonPayloadGoNames),
    ...daemonPayloadsBuiltInline,
    ...Object.keys(daemonPayloadKnownDrift),
  ])
    if (!tsInterfaces.has(name))
      failures.push(
        `audit-contract.mjs names daemon payload "${name}", which daemon-messages.ts no longer declares`,
      );
  failures.push(...compareDaemonPayloads(tsInterfaces, goStructs));
  return {
    failures,
    compared: [...tsInterfaces.keys()].filter(
      (name) => !daemonPayloadsBuiltInline.has(name),
    ).length,
  };
}

// --- Session event labels -------------------------------------------------

const tsSessionEventsPath = resolve(
  root,
  "packages/protocol/src/session-events.ts",
);
const tsProcessLabelsPath = resolve(
  root,
  "packages/protocol/src/process-labels.ts",
);
const goSessionEventLabelsPath = resolve(
  root,
  "apps/server/internal/store/session_event_labels.go",
);

const lowerFirst = (name) => name[0].toLowerCase() + name.slice(1);

/**
 * Reads the TS side: sessionEventLabels, processLabels,
 * completedProcessLabelKeys and the keys of the turn-end set.
 */
export function parseTsSessionEventLabels(sessionEvents, processLabelsSource) {
  const turnEnd = sessionEvents.match(
    /const\s+turnEndLabels\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/,
  );
  return {
    events: parseTsConstObject(sessionEvents, "sessionEventLabels"),
    process: parseTsConstObject(processLabelsSource, "processLabels"),
    completed: parseTsConstObject(
      // Typed as a Partial<Record<…>>: read it past its annotation.
      processLabelsSource.replace(
        /(export\s+const\s+completedProcessLabelKeys)[^=]*=/,
        "$1 =",
      ),
      "completedProcessLabelKeys",
    ),
    turnEnd: new Set(
      [...(turnEnd?.[1] ?? "").matchAll(/sessionEventLabels\.(\w+)/g)].map(
        ([, key]) => key,
      ),
    ),
    hidden: tsKeyList(processLabelsSource, "transcriptHiddenProcessLabelKeys"),
    heartbeat: tsKeyList(processLabelsSource, "heartbeatProcessLabelKeys"),
  };
}

/** The keys of a `export const <name> = [ "key", … ]` list. */
function tsKeyList(source, name) {
  const list = source.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`),
  );
  return new Set(
    [...(list?.[1] ?? "").matchAll(/"(\w+)"/g)].map(([, key]) => key),
  );
}

/** The protocol keys of a Go `var <name> = map[string]bool{ProcessLabelX: true, …}`. */
function goLabelSet(source, name) {
  const map = source.match(
    new RegExp(
      `var\\s+${name}\\s*=\\s*map\\[string\\]bool\\s*\\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  return new Set(
    [...(map?.[1] ?? "").matchAll(/ProcessLabel(\w+)\s*:\s*true/g)].map(
      ([, name]) => lowerFirst(name),
    ),
  );
}

/**
 * Reads the Go mirror: its EventLabel/ProcessLabel constants (by protocol
 * key), CompletedProcessLabels and the labels IsTurnEndLabel accepts.
 */
export function parseGoSessionEventLabels(source) {
  const events = new Map();
  const process = new Map();
  for (const [, kind, name, value] of source.matchAll(
    /^\s*(EventLabel|ProcessLabel)(\w+)\s*=\s*"([^"]+)"\s*$/gm,
  ))
    (kind === "EventLabel" ? events : process).set(lowerFirst(name), value);
  const completed = new Map();
  const map = source.match(
    /var\s+CompletedProcessLabels\s*=\s*map\[string\]string\s*\{([\s\S]*?)\n\}/,
  );
  for (const [, from, to] of (map?.[1] ?? "").matchAll(
    /ProcessLabel(\w+)\s*:\s*ProcessLabel(\w+)\s*,/g,
  ))
    completed.set(lowerFirst(from), lowerFirst(to));
  const turnEnd = source.match(
    /func\s+IsTurnEndLabel\([^)]*\)\s*bool\s*\{([\s\S]*?)\n\}/,
  );
  return {
    events,
    process,
    completed,
    turnEnd: new Set(
      [...(turnEnd?.[1] ?? "").matchAll(/EventLabel(\w+)/g)].map(([, name]) =>
        lowerFirst(name),
      ),
    ),
    hidden: goLabelSet(source, "TranscriptHiddenProcessLabels"),
    heartbeat: goLabelSet(source, "HeartbeatProcessLabels"),
  };
}

function mapDrift(label, ts, go) {
  const problems = setDrift(
    label,
    new Set(ts.keys()),
    "protocol",
    new Set(go.keys()),
    "Go",
  );
  for (const [key, value] of ts) {
    const goValue = go.get(key);
    if (goValue !== undefined && goValue !== value)
      problems.push(
        `${label} "${key}" is ${JSON.stringify(value)} in protocol but ${JSON.stringify(goValue)} in Go`,
      );
  }
  return problems;
}

/** @returns {string[]} failure descriptions, empty when both sides match */
export function compareSessionEventLabels(ts, go) {
  return [
    ...mapDrift("session event label", ts.events, go.events),
    ...mapDrift("process label", ts.process, go.process),
    ...mapDrift("completed process label", ts.completed, go.completed),
    ...setDrift(
      "turn-end label",
      ts.turnEnd,
      "isTurnEndLabel",
      go.turnEnd,
      "IsTurnEndLabel",
    ),
    ...setDrift(
      "transcript-hidden label",
      ts.hidden ?? new Set(),
      "transcriptHiddenProcessLabelKeys",
      go.hidden ?? new Set(),
      "TranscriptHiddenProcessLabels",
    ),
    ...setDrift(
      "heartbeat label",
      ts.heartbeat ?? new Set(),
      "heartbeatProcessLabelKeys",
      go.heartbeat ?? new Set(),
      "HeartbeatProcessLabels",
    ),
  ];
}

/**
 * Lines of a Go source that spell one of the labels as a literal: a Go
 * string or a single-quoted SQL string inside a raw string.
 * @returns {{ line: number, label: string }[]}
 */
export function findGoLabelLiterals(source, labels) {
  const found = [];
  source.split("\n").forEach((text, index) => {
    if (/^\s*\/\//.test(text)) return;
    for (const [, quoted, sql] of text.matchAll(
      /"((?:[^"\\]|\\.)*)"|'([^']*)'/g,
    )) {
      const label = quoted ?? sql;
      if (labels.has(label)) found.push({ line: index + 1, label });
    }
  });
  return found;
}

/**
 * Checks the checked-in session event labels (check 5).
 * @returns {{ failures: string[], labels: number }}
 */
export function sessionEventLabelFailures() {
  const ts = parseTsSessionEventLabels(
    readFileSync(tsSessionEventsPath, "utf8"),
    readFileSync(tsProcessLabelsPath, "utf8"),
  );
  const go = parseGoSessionEventLabels(
    readFileSync(goSessionEventLabelsPath, "utf8"),
  );
  const failures = [];
  if (
    ts.events.size === 0 ||
    ts.process.size === 0 ||
    ts.turnEnd.size === 0 ||
    ts.hidden.size === 0 ||
    ts.heartbeat.size === 0
  )
    failures.push("no session event or process labels parsed from protocol");
  failures.push(...compareSessionEventLabels(ts, go));
  const labels = new Set(ts.events.values());
  for (const { path, source } of goSources(
    goServerDir,
    (path) => path !== goSessionEventLabelsPath,
  ))
    for (const { line, label } of findGoLabelLiterals(source, labels))
      failures.push(
        `${relative(root, path)}:${line} spells session event label "${label}" as a literal; use its store.EventLabel constant`,
      );
  return { failures, labels: ts.events.size + ts.process.size };
}

// --- Session classes ------------------------------------------------------

const tsSessionClassesPath = resolve(
  root,
  "packages/protocol/src/session-classes.ts",
);
const goSessionClassesPath = resolve(
  root,
  "apps/server/internal/store/session_classes.go",
);

/**
 * Reads the TS side: sessionSources (key -> value), the active statuses
 * and the keys of the utility and prompt-only source lists.
 */
export function parseTsSessionClasses(source) {
  const list = (name) =>
    source.match(
      new RegExp(`const\\s+${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`),
    )?.[1] ?? "";
  const keys = (name) =>
    new Set(
      [...list(name).matchAll(/sessionSources\.(\w+)/g)].map(([, key]) => key),
    );
  return {
    sources: parseTsConstObject(source, "sessionSources"),
    active: new Set(
      [...list("activeSessionStatuses").matchAll(/"([^"]+)"/g)].map(
        ([, value]) => value,
      ),
    ),
    utility: keys("utilitySessionSources"),
    promptOnly: keys("promptOnlySessionSources"),
  };
}

/** Reads the Go mirror in the same shape, by protocol key. */
export function parseGoSessionClasses(source) {
  const list = (name) =>
    source.match(
      new RegExp(`var\\s+${name}\\s*=\\s*\\[\\]string\\{([^}]*)\\}`),
    )?.[1] ?? "";
  const keys = (name) =>
    new Set(
      [...list(name).matchAll(/SessionSource(\w+)/g)].map(([, name]) =>
        lowerFirst(name),
      ),
    );
  const sources = new Map();
  for (const [, name, value] of source.matchAll(
    /^\s*SessionSource(\w+)\s*=\s*"([^"]+)"\s*$/gm,
  ))
    sources.set(lowerFirst(name), value);
  return {
    sources,
    active: new Set(
      [...list("ActiveSessionStatuses").matchAll(/"([^"]+)"/g)].map(
        ([, value]) => value,
      ),
    ),
    utility: keys("UtilitySessionSources"),
    promptOnly: keys("PromptOnlySessionSources"),
  };
}

/** @returns {string[]} failure descriptions, empty when both sides match */
export function compareSessionClasses(ts, go) {
  return [
    ...mapDrift("session source", ts.sources, go.sources),
    ...setDrift(
      "active session status",
      ts.active,
      "activeSessionStatuses",
      go.active,
      "ActiveSessionStatuses",
    ),
    ...setDrift(
      "utility session source",
      ts.utility,
      "utilitySessionSources",
      go.utility,
      "UtilitySessionSources",
    ),
    ...setDrift(
      "prompt-only session source",
      ts.promptOnly,
      "promptOnlySessionSources",
      go.promptOnly,
      "PromptOnlySessionSources",
    ),
  ];
}

/**
 * Lines of a Go source that re-spell a session class: the active statuses
 * as an SQL list or a Go condition, or a session source compared as a
 * literal (`.Source == "naming"`, SQL `'$.source') NOT IN ('digest', …)`).
 * @returns {{ line: number, what: string }[]}
 */
export function findGoSessionClassLiterals(source, active, sources) {
  const found = [];
  const sameSet = (values) =>
    values.length === active.size && values.every((value) => active.has(value));
  const vocab = [...sources]
    .map((value) => value.replace(/\W/g, "\\$&"))
    .join("|");
  const compared = new RegExp(
    `[Ss]ource\\s*(?:==|!=)\\s*"(${vocab})"|"(${vocab})"\\s*(?:==|!=)\\s*[\\w.]*[Ss]ource\\b|'\\$\\.source'\\)(?:[^']*''\\))?\\s*(?:NOT\\s+)?(?:IN\\s*\\(|=)\\s*'(${vocab})'`,
  );
  source.split("\n").forEach((text, index) => {
    if (/^\s*\/\//.test(text)) return;
    const sqlLists = [
      ...text.matchAll(/\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)/g),
    ].map(([, items]) =>
      [...items.matchAll(/'([^']*)'/g)].map(([, value]) => value),
    );
    const goStatuses = [...active].every((status) =>
      text.includes(`"${status}"`),
    );
    if (goStatuses || sqlLists.some(sameSet))
      found.push({
        line: index + 1,
        what: "the active session statuses; use store.IsActiveSessionStatus or store.ActiveSessionStatusesSQL",
      });
    const source = text.match(compared);
    if (source)
      found.push({
        line: index + 1,
        what: `session source "${source[1] ?? source[2] ?? source[3]}" as a literal; use its store.SessionSource constant or class`,
      });
  });
  return found;
}

/**
 * Checks the checked-in session classes (check 6).
 * @returns {{ failures: string[], values: number }}
 */
export function sessionClassFailures() {
  const ts = parseTsSessionClasses(readFileSync(tsSessionClassesPath, "utf8"));
  const go = parseGoSessionClasses(readFileSync(goSessionClassesPath, "utf8"));
  const failures = [];
  if (
    ts.sources.size === 0 ||
    ts.active.size === 0 ||
    ts.utility.size === 0 ||
    ts.promptOnly.size === 0
  )
    failures.push(
      "no session sources or classes parsed from session-classes.ts",
    );
  failures.push(...compareSessionClasses(ts, go));
  for (const { path, source } of goSources(
    goServerDir,
    (path) => path !== goSessionClassesPath,
  ))
    for (const { line, what } of findGoSessionClassLiterals(
      source,
      ts.active,
      new Set(ts.sources.values()),
    ))
      failures.push(`${relative(root, path)}:${line} spells ${what}`);
  return { failures, values: ts.sources.size + ts.active.size };
}

export function readMerged(paths, parse) {
  const merged = new Map();
  for (const path of paths)
    for (const [name, fields] of parse(readFileSync(path, "utf8")))
      merged.set(name, fields);
  return merged;
}

/**
 * Checks the checked-in browser event vocabulary (check 3).
 * @returns {{ failures: string[], names: number }}
 */
export function browserEventFailures() {
  const ts = parseTsBrowserEvents(readFileSync(tsBrowserEventsPath, "utf8"));
  const goBrowserEventSource = goSources(goBrowserEventDir, () => true)
    .map(({ source }) => source)
    .join("\n");
  const go = parseGoBrowserEvents(goBrowserEventSource);
  const failures = [];
  if (ts.events.size === 0)
    failures.push("no browser event names parsed from browser-events.ts");
  if (go.constants.size === 0)
    failures.push("no Type constants parsed from package browserevent");
  const elsewhere = goSources(
    goServerDir,
    (path) => !path.startsWith(goBrowserEventDir),
  );
  const goNotices = parseGoNotices(goBrowserEventSource, go.constants);
  failures.push(...compareBrowserEvents(ts, go, goNotices));
  const names = new Set(go.constants.values());
  for (const { path, source } of elsewhere)
    for (const { line, name } of findGoEventLiterals(source, names))
      failures.push(
        `${relative(root, path)}:${line} spells browser event "${name}" as a literal; use its browserevent constant`,
      );
  return { failures, names: names.size };
}

function main() {
  const tsInterfaces = readMerged(tsDtoPaths, parseTsInterfaces);
  const goStructs = readMerged(goDtoPaths, parseGoStructs);
  const tsMessageTypes = parseTsMessageTypes(
    readFileSync(tsMessagesPath, "utf8"),
  );
  const goMessageTypes = parseGoMessageTypes(
    readFileSync(goMessagesPath, "utf8"),
  );

  const failures = compareDtoFields(tsInterfaces, goStructs);
  if (tsMessageTypes.size === 0) {
    failures.push(
      "no daemon message types parsed from packages/protocol/src/daemon-messages.ts",
    );
  }
  if (goMessageTypes.size === 0) {
    failures.push(
      "no ws*Type constants parsed from apps/server/internal/httpapi/daemon_wire.go",
    );
  }
  failures.push(...compareMessageVocabularies(tsMessageTypes, goMessageTypes));
  const browserEvents = browserEventFailures();
  failures.push(...browserEvents.failures);
  const daemonPayloads = daemonPayloadFailures();
  failures.push(...daemonPayloads.failures);
  const sessionLabels = sessionEventLabelFailures();
  failures.push(...sessionLabels.failures);
  const sessionClasses = sessionClassFailures();
  failures.push(...sessionClasses.failures);

  if (failures.length > 0) {
    console.error("Contract guard failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      `\nChecked ${tsInterfaces.size} TS interfaces against ${goStructs.size} Go structs ` +
        `and ${tsMessageTypes.size} TS daemon message types against ${goMessageTypes.size} Go constants.`,
    );
    process.exit(1);
  }

  console.log(
    `Contract guard passed: ${tsInterfaces.size} TS interfaces match their Go structs; ` +
      `${tsMessageTypes.size} daemon message type names match the Go daemon_wire constants; ` +
      `${browserEvents.names} browser event names, their payload types and notices match package browserevent; ` +
      `${daemonPayloads.compared} daemon request payloads match their Go structs ` +
      `(names, sets and JSON field names only, not field types); ` +
      `${sessionLabels.labels} session event and process labels match their Go constants; ` +
      `${sessionClasses.values} session sources and active statuses, and their classes, match the Go store.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
