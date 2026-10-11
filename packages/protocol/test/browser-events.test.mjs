import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  browserEventTypes,
  browserNoticeTypes,
  browserStreamControlTypes,
  isBrowserEventType,
  isBrowserNoticeType,
  parseProtocolEnvelopeJSON,
} from "../dist/index.js";

// One example of every stream message; the server's browserevent package
// checks that its Go payloads write exactly these.
const fixturesText = readFileSync(
  new URL("./browser-event-fixtures.json", import.meta.url),
  "utf8",
);
const fixtures = JSON.parse(fixturesText);

const checkPath = fileURLToPath(
  new URL("./browser-event-fixtures.check.ts", import.meta.url),
);

/**
 * Type-checks messages (JSON text) as the stream's messages: each must be
 * an event or stream control message whose payload is exactly its type's.
 * @returns {string[]} the compiler's complaints
 */
function typeCheckMessages(messagesText) {
  const source =
    `import type { BrowserEvent, BrowserStreamControl } from "../dist/index.js";\n` +
    `export const messages: Array<BrowserEvent | BrowserStreamControl> = ${messagesText};\n`;
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (path) => path === checkPath || fileExists(path);
  host.readFile = (path) => (path === checkPath ? source : readFile(path));
  host.getSourceFile = (path, language, ...rest) =>
    path === checkPath
      ? ts.createSourceFile(path, source, language)
      : getSourceFile(path, language, ...rest);
  const program = ts.createProgram([checkPath], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

test("the fixtures hold one message of every name", () => {
  const names = [
    ...Object.values(browserEventTypes),
    ...Object.values(browserStreamControlTypes),
  ].sort();
  assert.deepEqual(fixtures.map((fixture) => fixture.type).sort(), names);
});

test("every fixture parses as a stream envelope of its kind", () => {
  const controls = new Set(Object.values(browserStreamControlTypes));
  for (const fixture of fixtures) {
    const envelope = parseProtocolEnvelopeJSON(JSON.stringify(fixture));
    assert.deepEqual(envelope, fixture);
    assert.equal(
      isBrowserEventType(envelope.type),
      !controls.has(envelope.type),
      envelope.type,
    );
  }
});

test("notices are events", () => {
  for (const notice of browserNoticeTypes) {
    assert.ok(isBrowserEventType(notice), notice);
    assert.ok(isBrowserNoticeType(notice), notice);
  }
  assert.equal(isBrowserNoticeType(browserEventTypes.issueUpdated), false);
});

test("the fixtures type-check as BrowserEventPayloads", () => {
  assert.deepEqual(typeCheckMessages(fixturesText), []);
});

test("the type check refuses a payload that is not its type's", () => {
  const refused = [
    // A field the payload type does not have.
    {
      type: "workspace_members_updated",
      payload: { workspaceId: "ws_atlas", role: "viewer" },
    },
    // A required field left out.
    { type: "chats_changed", payload: { workspaceId: "ws_atlas", chats: [] } },
    // A value outside the field's literal type.
    { type: "resync", payload: { reason: "bored" } },
    // Another event's payload.
    {
      type: "issue_environment_changed",
      payload: { workspaceId: "ws_atlas", sessionId: "s", taskId: "t" },
    },
  ];
  for (const message of refused)
    assert.notDeepEqual(
      typeCheckMessages(JSON.stringify([message])),
      [],
      JSON.stringify(message),
    );
});
