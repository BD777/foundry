import assert from "node:assert/strict";
import test from "node:test";
import { agentNiceValue } from "../dist/platform/process/agent-processes.js";

test("agent process groups are renices to 5 on Linux and macOS", () => {
  assert.equal(agentNiceValue("linux"), 5);
  assert.equal(agentNiceValue("darwin"), 5);
  assert.equal(agentNiceValue("win32"), undefined);
});
