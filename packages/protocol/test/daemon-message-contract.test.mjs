// Regression tests for the cross-language contract guard. The parsers are
// exercised against inline fixtures (no source rewriting) plus the real
// checked-in sources, so a drifting vocabulary fails here as well as in
// `pnpm audit:contract`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  compareDtoFields,
  compareMessageVocabularies,
  parseGoMessageTypes,
  parseGoStructs,
  parseTsInterfaces,
  parseTsMessageTypes,
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
      resolve(root, "apps/server/internal/httpapi/daemon_ws.go"),
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
  const tsInterfaces = parseTsInterfaces(
    readFileSync(resolve(root, "packages/protocol/src/index.ts"), "utf8"),
  );
  const goStructs = parseGoStructs(
    readFileSync(resolve(root, "apps/server/internal/store/models.go"), "utf8"),
  );
  assert.ok(tsInterfaces.size > 0, "expected TS interfaces to parse");
  assert.deepEqual(compareDtoFields(tsInterfaces, goStructs), []);
});
