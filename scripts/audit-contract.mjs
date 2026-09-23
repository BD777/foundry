#!/usr/bin/env node
// Cross-language contract guard. Two independent mechanical checks:
//
//   1. DTO field parity — for every TS interface in
//      packages/protocol/src/index.ts a Go struct with the same name must
//      exist in apps/server/internal/store/models.go, and their JSON field
//      names must match (TS field name == Go `json:"..."` tag).
//
//   2. Daemon message vocabulary set parity — the string values in
//      packages/protocol/src/daemon-messages.ts must be exactly the set of
//      `ws*Type` constant values in apps/server/internal/httpapi/daemon_ws.go.
//
// Both checks compare names and literal sets only. Neither validates payload
// type semantics, envelope direction, or handler coverage.
//
// Usage: node scripts/audit-contract.mjs

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const tsPath = resolve(root, "packages/protocol/src/index.ts");
const goPath = resolve(root, "apps/server/internal/store/models.go");
const tsMessagesPath = resolve(
  root,
  "packages/protocol/src/daemon-messages.ts",
);
const goMessagesPath = resolve(
  root,
  "apps/server/internal/httpapi/daemon_ws.go",
);

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
  const block = source.match(
    /export\s+const\s+daemonMessageTypes\s*=\s*\{([\s\S]*?)\n\}/,
  );
  if (!block) return new Set();
  const values = new Set();
  const re = /^\s*\w+\s*:\s*"([^"]+)"\s*,?\s*$/gm;
  let match;
  while ((match = re.exec(block[1])) !== null) values.add(match[1]);
  return values;
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

function main() {
  const tsInterfaces = parseTsInterfaces(readFileSync(tsPath, "utf8"));
  const goStructs = parseGoStructs(readFileSync(goPath, "utf8"));
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
      `${tsMessageTypes.size} daemon message type names match the Go daemon_ws constants ` +
      `(name/set parity only, not payload semantics).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
