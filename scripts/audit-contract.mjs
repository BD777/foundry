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
//      `ws*Type` constant values in apps/server/internal/httpapi/daemon_ws.go.
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
  "packages/protocol/src/index.ts",
  "packages/protocol/src/feishu.ts",
  "packages/protocol/src/external-accounts.ts",
  "packages/protocol/src/browser-events.ts",
  "packages/protocol/src/resources.ts",
].map((path) => resolve(root, path));
export const goDtoPaths = [
  "apps/server/internal/store/models.go",
  "apps/server/internal/store/feishu.go",
  "apps/server/internal/store/external_accounts.go",
  "apps/server/internal/browserevent/payloads.go",
  "apps/server/internal/store/resources.go",
].map((path) => resolve(root, path));
const tsMessagesPath = resolve(
  root,
  "packages/protocol/src/daemon-messages.ts",
);
const goMessagesPath = resolve(
  root,
  "apps/server/internal/httpapi/daemon_ws.go",
);
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
      `daemon message types declared in TS but not in Go daemon_ws.go: ${missingInGo.join(", ")}`,
    );
  }
  if (missingInTs.length > 0) {
    problems.push(
      `daemon message types declared in Go daemon_ws.go but not in TS: ${missingInTs.join(", ")}`,
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
      "no ws*Type constants parsed from apps/server/internal/httpapi/daemon_ws.go",
    );
  }
  failures.push(...compareMessageVocabularies(tsMessageTypes, goMessageTypes));
  const browserEvents = browserEventFailures();
  failures.push(...browserEvents.failures);

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
      `${tsMessageTypes.size} daemon message type names match the Go daemon_ws constants; ` +
      `${browserEvents.names} browser event names, their payload types and notices match package browserevent ` +
      `(names, sets and JSON field names only, not field types).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
