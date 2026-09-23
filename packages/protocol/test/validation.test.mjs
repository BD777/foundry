import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolValidationError,
  parseProtocolEnvelope,
  parseProtocolEnvelopeJSON,
} from "../dist/index.js";

test("parses a valid protocol envelope", () => {
  assert.deepEqual(
    parseProtocolEnvelopeJSON(
      JSON.stringify({
        id: "msg_1",
        payload: { workspaceId: "ws_1" },
        type: "read_file",
      }),
    ),
    {
      id: "msg_1",
      payload: { workspaceId: "ws_1" },
      type: "read_file",
    },
  );
});

test("rejects missing and malformed message types", () => {
  assert.throws(
    () => parseProtocolEnvelope({ payload: {} }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseProtocolEnvelope({ type: "Read File" }),
    /must match/,
  );
});

test("rejects unknown envelope fields", () => {
  assert.throws(
    () => parseProtocolEnvelope({ type: "heartbeat", token: "secret" }),
    /unknown field "token"/,
  );
});

test("rejects oversized identifiers and invalid JSON", () => {
  assert.throws(
    () => parseProtocolEnvelope({ id: "x".repeat(257), type: "heartbeat" }),
    /exceeds 256/,
  );
  assert.throws(() => parseProtocolEnvelopeJSON("{"), /not valid JSON/);
});
