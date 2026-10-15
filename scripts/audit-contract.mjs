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
  "packages/protocol/src/skills.ts",
  "packages/protocol/src/workspace.ts",
  "packages/protocol/src/feishu.ts",
  "packages/protocol/src/external-accounts.ts",
  "packages/protocol/src/connectors.ts",
  "packages/protocol/src/browser-events.ts",
  "packages/protocol/src/resources.ts",
  "packages/protocol/src/personal-agent.ts",
  "packages/protocol/src/personal-agent-list.ts",
].map((path) => resolve(root, path));
export const goDtoPaths = [
  "apps/server/internal/store/workspaces.go",
  "apps/server/internal/store/devices.go",
  "apps/server/internal/store/device_sharing.go",
  "apps/server/internal/store/device_placement.go",
  "apps/server/internal/store/profiles.go",
  "apps/server/internal/store/skills.go",
  "apps/server/internal/store/skill_repositories.go",
  "apps/server/internal/store/sessions.go",
  "apps/server/internal/store/session_files.go",
  "apps/server/internal/store/session_timers.go",
  "apps/server/internal/store/session_activity.go",
  "apps/server/internal/store/chats.go",
  "apps/server/internal/store/issues.go",
  "apps/server/internal/store/projections.go",
  "apps/server/internal/store/feishu.go",
  "apps/server/internal/store/external_accounts.go",
  "apps/server/internal/store/device_connectors.go",
  "apps/server/internal/browserevent/payloads.go",
  "apps/server/internal/store/resources.go",
  "apps/server/internal/store/personal_agent.go",
  "apps/server/internal/store/personal_agent_list.go",
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
      `(names, sets and JSON field names only, not field types).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
