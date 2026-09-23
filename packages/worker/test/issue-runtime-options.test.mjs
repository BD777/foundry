import assert from "node:assert/strict";
import test from "node:test";
import { issueRuntimeOptions } from "../dist/issue-runtime-options.js";
import {
  claudeEffort,
  claudeSdkPermissionMode,
  codexReasoningEffort,
  codexApprovalPolicy,
  codexSandboxMode,
} from "../dist/runner.js";

test("Issue model/effort survive session construction and autonomous permissions override interactive profiles", () => {
  const profile = {
    model: "profile-model",
    claudeEffort: "low",
    claudePermissionMode: "plan",
    codexReasoningEffort: "low",
    codexApprovalPolicy: "on-request",
    codexSandboxMode: "read-only",
  };
  for (const runtime of ["claude", "codex"]) {
    const issue = {
      runtime,
      model: "chosen-model",
      profileId: "chosen-profile",
      claudeEffort: "max",
      codexReasoningEffort: "xhigh",
      codexSpeed: "fast",
    };
    const session = { ...issueRuntimeOptions(issue), provider: runtime };
    assert.equal(session.model, "chosen-model");
    assert.equal(session.profileId, "chosen-profile");
    assert.equal(
      claudeSdkPermissionMode(session, profile, {}),
      "bypassPermissions",
    );
    assert.equal(codexApprovalPolicy(session, profile), "never");
    assert.equal(codexSandboxMode(session, profile), "danger-full-access");
    if (runtime === "claude") {
      assert.equal(claudeEffort(session, profile), "max");
      assert.equal(session.codexReasoningEffort, undefined);
    } else {
      assert.equal(codexReasoningEffort(session, profile), "xhigh");
      assert.equal(session.claudeEffort, undefined);
      assert.equal(session.codexSpeed, "fast");
    }
  }
  assert.equal(issueRuntimeOptions({ runtime: "claude" }).model, undefined);
});
