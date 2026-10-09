import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeLaunchPlan,
  codexFoundryTools,
  foundryClaudeSettings,
  resolvedClaudeCredential,
} from "../dist/session-policy.js";
import { claudeRootBypassRefusal } from "../dist/runner.js";

const session = { id: "sess_1", prompt: "hello", workspaceId: "ws_1" };

// Managed plans resolve real workspace paths for project instructions.
const workspaceRoot = mkdtempSync(join(tmpdir(), "session-policy-ws-"));
const workspacePath = join(workspaceRoot, "workspace");
mkdirSync(workspacePath, { recursive: true });
test.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const compatibleProfile = (overrides = {}) => ({
  id: "claude_local",
  runtime: "claude",
  label: "team-relay",
  origin: "server",
  connectionType: "anthropic_compatible",
  baseUrl: "https://relay.example.invalid",
  model: "model_hub/example",
  ...overrides,
});

test("Foundry flag settings pin auto-compaction on regardless of local user config", () => {
  const settings = foundryClaudeSettings(compatibleProfile(), session);
  assert.equal(settings.autoCompactEnabled, true);
  assert.equal(
    settings.env.ANTHROPIC_BASE_URL,
    "https://relay.example.invalid",
  );
  assert.equal(settings.env.ANTHROPIC_MODEL, "model_hub/example");
});

test("Claude Code keeps its own skills, managed or not", () => {
  const managed = {
    pluginDir: "/managed/set-a",
    skills: [{ name: "qa", dir: "/managed/set-a/skills/qa" }],
  };
  assert.equal(
    "disableBundledSkills" in
      foundryClaudeSettings(compatibleProfile(), session, managed),
    false,
  );
  assert.equal(
    "disableBundledSkills" in
      foundryClaudeSettings(compatibleProfile(), session),
    false,
  );
});

test("custom connection without a credential gets an actionable warning; a keyed one does not", () => {
  const keyed = buildClaudeLaunchPlan({
    workspacePath: "/tmp",
    session,
    profile: compatibleProfile({ apiKey: "fixture-key" }),
  });
  assert.deepEqual(keyed.warnings, []);
  assert.equal(resolvedClaudeCredential(keyed.env), "fixture-key");

  const keyless = buildClaudeLaunchPlan({
    workspacePath: "/tmp",
    session,
    profile: compatibleProfile(),
  });
  assert.equal(keyless.warnings.length, 1);
  assert.match(keyless.warnings[0], /resolved no credential/);
  assert.match(keyless.warnings[0], /401/);

  const official = buildClaudeLaunchPlan({
    workspacePath: "/tmp",
    session,
    profile: {
      id: "claude_native",
      runtime: "claude",
      label: "claude login",
      connectionType: "local_login",
    },
  });
  assert.deepEqual(official.warnings, []);
});

test("one plan drives SDK and CLI paths: prompt rewrite is SDK-only and isolation flags match", () => {
  const managed = {
    pluginDir: "/managed/set-a",
    skills: [{ name: "qa", dir: "/managed/set-a/skills/qa" }],
    officialSkills: [{ name: "simplify" }],
  };
  const plan = buildClaudeLaunchPlan({
    workspacePath,
    session: { ...session, prompt: "/qa run checks" },
    profile: compatibleProfile({ apiKey: "fixture-key" }),
    managedSkills: managed,
  });
  assert.equal(plan.prompt, "/foundry-workspace:qa run checks");
  assert.equal(plan.sdk.settingSources, undefined);
  assert.match(plan.sdk.systemPrompt.append, /^Foundry device notes:/);
  // Claude Code's own skills stay enabled beside the workspace's.
  assert.deepEqual(plan.sdk.skills, ["simplify", "foundry-workspace:qa"]);
  assert.deepEqual(plan.sdk.plugins, [
    { type: "local", path: "/managed/set-a" },
  ]);
  assert.equal(plan.settings.disableBundledSkills, undefined);
  assert.equal(plan.settings.autoCompactEnabled, true);
  // An official skill may be invoked directly; a device-installed one may not.
  plan.validatePrompt("/simplify the diff");
  assert.throws(
    () => plan.validatePrompt("/my-local-skill go"),
    /not configured/,
  );
});

test("unconfigured skill invocations and custom commands fail closed from the plan", () => {
  const managed = {
    pluginDir: "/managed/set-a",
    skills: [{ name: "qa", dir: "/managed/set-a/skills/qa" }],
  };
  assert.throws(
    () =>
      buildClaudeLaunchPlan({
        workspacePath,
        session: { ...session, prompt: "/ccm-domain-mapping now" },
        profile: compatibleProfile({ apiKey: "k" }),
        managedSkills: managed,
      }),
    /not configured for this workspace/,
  );
  assert.throws(
    () =>
      buildClaudeLaunchPlan({
        workspacePath,
        session: { ...session, prompt: "/qa now" },
        profile: compatibleProfile({ apiKey: "k", command: "custom-cli" }),
        managedSkills: managed,
      }),
    /Custom runtime commands cannot enforce workspace skill isolation/,
  );
});

test("the launch plan keeps the native session and its imported turns", () => {
  const plan = buildClaudeLaunchPlan({
    workspacePath,
    session: {
      ...session,
      nativeSessionId: "native-kept",
      input: {
        id: "in",
        prompt: "continue",
        importedContext: "User: missed turn",
      },
    },
    profile: compatibleProfile({ apiKey: "k" }),
    managedSkills: {
      pluginDir: "/managed/set-b",
      skills: [{ name: "qa", dir: "/managed/set-b/skills/qa" }],
    },
  });
  assert.equal("session" in plan, false);
  assert.match(plan.prompt, /User: missed turn/);
  assert.match(plan.prompt, /continue$/);
});

test("sessions with an orchestration identity get the Foundry tools with their own token", async () => {
  const { registerSessionAmbientEnv } =
    await import("../dist/session-ambient.js");
  const ambient = {
    serverURL: "http://127.0.0.1:31982",
    sessionToken: "token-for-sess_tools",
    workspaceID: "ws_1",
  };
  const unregister = registerSessionAmbientEnv("sess_tools", ambient);
  try {
    const chat = { ...session, id: "sess_tools", source: "chat" };
    const plan = buildClaudeLaunchPlan({
      workspacePath: "/tmp",
      session: chat,
      profile: compatibleProfile({ apiKey: "k" }),
    });
    assert.deepEqual(plan.mcpServers, {
      foundry: {
        type: "http",
        url: "http://127.0.0.1:31982/api/mcp",
        headers: { Authorization: "Bearer token-for-sess_tools" },
        // Outlasts the server's 10-minute cap on a waiting call.
        timeout: 660000,
      },
    });
    assert.equal(
      plan.sdk.mcpServers,
      undefined,
      "kept out of the runtime identity",
    );
    assert.deepEqual(plan.sdk.allowedTools, ["mcp__foundry"]);
    const naming = buildClaudeLaunchPlan({
      workspacePath: "/tmp",
      session: { ...chat, source: "naming" },
      profile: compatibleProfile({ apiKey: "k" }),
    });
    assert.equal(naming.mcpServers, undefined, "utility sessions get no tools");
    assert.equal(naming.sdk.allowedTools, undefined);
  } finally {
    unregister();
  }
  const anonymous = buildClaudeLaunchPlan({
    workspacePath: "/tmp",
    session: { ...session, id: "sess_without_token" },
    profile: compatibleProfile({ apiKey: "k" }),
  });
  assert.equal(anonymous.mcpServers, undefined, "no token, no tools");
});

test("Codex sessions get the same pre-approved Foundry tools, token read from their env", async () => {
  const { registerSessionAmbientEnv } =
    await import("../dist/session-ambient.js");
  const unregister = registerSessionAmbientEnv("sess_codex_tools", {
    serverURL: "http://127.0.0.1:31982",
    sessionToken: "token-for-sess_codex_tools",
    workspaceID: "ws_1",
  });
  try {
    const tools = codexFoundryTools({
      ...session,
      id: "sess_codex_tools",
      source: "chat",
    });
    const server = {
      url: "http://127.0.0.1:31982/api/mcp",
      bearer_token_env_var: "FOUNDRY_SESSION_TOKEN",
      default_tools_approval_mode: "approve",
      // Outlasts the server's 10-minute cap on a waiting call.
      tool_timeout_sec: 660,
    };
    assert.deepEqual(tools.config, { mcp_servers: { foundry: server } });
    assert.equal(
      JSON.stringify(tools.config).includes("token-for-sess_codex_tools"),
      false,
      "the token stays in the environment, never in config or argv",
    );
    assert.equal(
      codexFoundryTools({
        ...session,
        id: "sess_codex_tools",
        source: "naming",
      }),
      undefined,
      "utility sessions get no tools",
    );
  } finally {
    unregister();
  }
  assert.equal(
    codexFoundryTools({ ...session, id: "sess_unknown" }),
    undefined,
  );
});

test("an Issue's clarification runs only the read tools its role allows", async () => {
  const { registerSessionAmbientEnv } =
    await import("../dist/session-ambient.js");
  const { claudePermissionMode, codexSandboxMode, codexApprovalPolicy } =
    await import("../dist/runner.js");
  const clarification = {
    ...session,
    id: "sess_clarify",
    source: "issue",
    role: "issue_clarification",
    issueId: "iss_1",
  };
  const unregister = registerSessionAmbientEnv("sess_clarify", {
    serverURL: "http://127.0.0.1:31982",
    sessionToken: "token-for-sess_clarify",
    workspaceID: "ws_1",
  });
  try {
    // Whatever the profile asks for, the role decides.
    const profile = compatibleProfile({
      apiKey: "k",
      claudePermissionMode: "bypassPermissions",
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "on-request",
    });
    const plan = buildClaudeLaunchPlan({
      workspacePath,
      session: clarification,
      profile,
    });
    assert.equal(plan.sdk.permissionMode, "dontAsk");
    assert.deepEqual(plan.sdk.allowedTools, [
      "Read",
      "Grep",
      "Glob",
      "mcp__foundry__list_sessions",
      "mcp__foundry__read_context",
    ]);
    for (const tool of ["Bash", "Write", "Edit", "Task", "WebFetch"])
      assert.ok(plan.sdk.disallowedTools.includes(tool), tool);
    assert.deepEqual(plan.sdk.settingSources, ["project"]);
    assert.equal(plan.sdk.strictMcpConfig, true);
    assert.ok(plan.mcpServers.foundry, "the Foundry tools are still there");
    assert.equal(claudePermissionMode(clarification, profile), "dontAsk");
    assert.equal(codexSandboxMode(clarification, profile), "read-only");
    assert.equal(codexApprovalPolicy(clarification, profile), "never");
    const codex = codexFoundryTools(clarification);
    assert.deepEqual(codex.config.mcp_servers.foundry.enabled_tools, [
      "list_sessions",
      "read_context",
    ]);
    // A chat keeps the person's own choice.
    assert.equal(claudePermissionMode(session, profile), "bypassPermissions");
  } finally {
    unregister();
  }
});

test("root with Bypass permissions is refused up front unless the process runs in a sandbox", () => {
  assert.match(
    claudeRootBypassRefusal("bypassPermissions", 0, {}),
    /runs as root/,
  );
  assert.equal(
    claudeRootBypassRefusal("bypassPermissions", 1000, {}),
    undefined,
  );
  assert.equal(claudeRootBypassRefusal("acceptEdits", 0, {}), undefined);
  assert.equal(
    claudeRootBypassRefusal("bypassPermissions", 0, { IS_SANDBOX: "1" }),
    undefined,
  );
  assert.equal(
    claudeRootBypassRefusal("bypassPermissions", 0, {
      CLAUDE_CODE_BUBBLEWRAP: "1",
    }),
    undefined,
  );
});
