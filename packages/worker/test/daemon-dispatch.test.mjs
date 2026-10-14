import assert from "node:assert/strict";
import test from "node:test";
import { daemonMessageTypes } from "@bd777/foundry-protocol";
import { daemonDispatch } from "../dist/daemon-connection.js";

// Every message type the server sends a daemon: dropping one while moving
// handlers would leave its requests unanswered.
const serverMessages = [
  "error",
  "ack",
  "registered",
  "sessionTimers",
  "attachmentWrite",
  "attachmentRead",
  "readFile",
  "readSessionFile",
  "readSessionFileDiff",
  "readBackgroundTaskOutput",
  "stopBackgroundTask",
  "readSessionUsage",
  "readSubagentTranscript",
  "listSubagents",
  "listDirectories",
  "listWorkspaceTree",
  "inspectWorkspace",
  "setupWorkspace",
  "forgetWorkspace",
  "relinkWorkspace",
  "findMovedWorkspace",
  "inspectNativeAccount",
  "readWorkerUpdateStatus",
  "updateWorker",
  "installNativeCli",
  "listAgentModels",
  "readProviderKey",
  "runDiagnostics",
  "runRepair",
  "readRepositoryRefs",
  "fetchSkillRepository",
  "installTool",
  "scanSkills",
  "readSkillFile",
  "readSkillContent",
  "upsertAgentProfile",
  "refreshResources",
  "resourceOperate",
  "resourceReset",
  "resourceSettings",
  "installResourceBackend",
  "upsertAgentRuntimeSettings",
  "steerSession",
  "cancelSession",
  "recoverSession",
  "runSession",
  "issueEnvironment",
  "evidenceRequest",
];

test("the daemon handles every message type the server sends it", () => {
  const expected = serverMessages.map((name) => {
    assert.ok(daemonMessageTypes[name], `${name} is a daemon message type`);
    return daemonMessageTypes[name];
  });
  assert.equal(expected.length, 48);
  assert.deepEqual(daemonDispatch.types().sort(), expected.sort());
});
