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
  "deviceSharing",
  "sessionTimers",
  "serviceTunnelOpen",
  "attachmentWrite",
  "attachmentRead",
  "knowledgeCommand",
  "contextPatch",
  "readFile",
  "readDeviceFile",
  "readSessionFile",
  "readSessionFileDiff",
  "readBackgroundTaskOutput",
  "stopBackgroundTask",
  "readSessionUsage",
  "readSubagentTranscript",
  "readNativeHistory",
  "readExecutionRunner",
  "switchExecutionRunner",
  "nativeArchive",
  "listSubagents",
  "listDirectories",
  "listWorkspaceTree",
  "listServiceListeners",
  "inspectWorkspace",
  "setupWorkspace",
  "forgetWorkspace",
  "relinkWorkspace",
  "findMovedWorkspace",
  "inspectNativeAccount",
  "checkExternalConnection",
  "removeExternalConnection",
  "readExternalConnectionSetup",
  "startExternalConnectionSetup",
  "cancelExternalConnectionSetup",
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
  "connectorRequest",
  "registrationNeeded",
  "scanSkills",
  "prepareSkills",
  "readSkillFile",
  "readSkillContent",
  "refreshWorkspaceSkills",
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
  assert.equal(expected.length, 67);
  assert.deepEqual(daemonDispatch.types().sort(), expected.sort());
});
