import assert from "node:assert/strict";
import test from "node:test";
import {
  projectedProfileAuthMode,
  projectedProfileStatusDetail,
} from "../dist/agent-profile-state.js";

test("custom command profiles project as local configuration", () => {
  const input = {
    command: "/usr/local/bin/foundry-test-agent",
    connectionType: "custom_command",
    hasAuth: false,
  };

  assert.equal(projectedProfileAuthMode(input), "local_config");
  assert.equal(projectedProfileStatusDetail(input), undefined);
});

test("custom command profiles report a missing command", () => {
  const input = {
    connectionType: "custom_command",
    hasAuth: false,
  };

  assert.equal(projectedProfileAuthMode(input), "local_config");
  assert.equal(
    projectedProfileStatusDetail(input),
    "Command profile has no command configured.",
  );
});

test("compatible profiles still require auth and a base URL", () => {
  assert.equal(
    projectedProfileStatusDetail({
      baseUrl: "https://provider.example/v1",
      connectionType: "openai_compatible",
      hasAuth: false,
    }),
    "No local secret or matching environment variable is configured.",
  );
  assert.equal(
    projectedProfileStatusDetail({
      connectionType: "openai_compatible",
      hasAuth: true,
    }),
    "Provider base URL is empty.",
  );
});

test("local login profiles preserve local provider auth state", () => {
  const localHealth = {
    authMode: "local_config",
    provider: "codex",
    secretStored: "local",
    status: "healthy",
  };

  assert.equal(
    projectedProfileAuthMode({
      connectionType: "local_login",
      hasAuth: false,
      localHealth,
    }),
    "local_config",
  );
});
