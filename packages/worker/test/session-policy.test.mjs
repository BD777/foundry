import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeLaunchPlan,
  foundryClaudeSettings,
  resolvedClaudeCredential,
} from "../dist/session-policy.js";

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

test("managed settings disable bundled skills; ordinary sessions leave them alone", () => {
  const managed = {
    pluginDir: "/managed/set-a",
    skills: [{ name: "qa", dir: "/managed/set-a/skills/qa" }],
  };
  assert.equal(
    foundryClaudeSettings(compatibleProfile(), session, managed)
      .disableBundledSkills,
    true,
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
  };
  const plan = buildClaudeLaunchPlan({
    workspacePath,
    session: { ...session, prompt: "/qa run checks" },
    profile: compatibleProfile({ apiKey: "fixture-key" }),
    managedSkills: managed,
  });
  assert.equal(plan.prompt, "/foundry-workspace:qa run checks");
  assert.equal(plan.cliPrompt, "/qa run checks");
  assert.deepEqual(plan.sdk.settingSources, []);
  assert.deepEqual(plan.sdk.skills, ["foundry-workspace:qa"]);
  assert.deepEqual(plan.sdk.plugins, [
    { type: "local", path: "/managed/set-a" },
  ]);
  const args = plan.cliArgs;
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.match(
    args[args.indexOf("--append-system-prompt") + 1],
    /\/qa\/SKILL.md/,
  );
  assert.equal(plan.settings.disableBundledSkills, true);
  assert.equal(plan.settings.autoCompactEnabled, true);
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

test("legacy native context resets and the receipt closure certifies the fresh session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-policy-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousRoot = process.env.FOUNDRY_EXECUTION_SESSION_ROOT;
  process.env.FOUNDRY_EXECUTION_SESSION_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined)
      delete process.env.FOUNDRY_EXECUTION_SESSION_ROOT;
    else process.env.FOUNDRY_EXECUTION_SESSION_ROOT = previousRoot;
  });
  const managed = {
    pluginDir: "/managed/set-a",
    skills: [{ name: "qa", dir: "/managed/set-a/skills/qa" }],
  };
  const old = {
    ...session,
    nativeSessionId: "native-legacy",
    prompt: "continue",
  };
  const first = buildClaudeLaunchPlan({
    workspacePath,
    session: old,
    profile: compatibleProfile({ apiKey: "k" }),
    managedSkills: managed,
  });
  assert.equal(first.reset, true);
  assert.equal(first.session.nativeSessionId, undefined);
  first.recordNativeSession("native-fresh");
  const second = buildClaudeLaunchPlan({
    workspacePath,
    session: { ...session, nativeSessionId: "native-fresh", prompt: "again" },
    profile: compatibleProfile({ apiKey: "k" }),
    managedSkills: managed,
  });
  assert.equal(second.reset, false);
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
      },
    });
    assert.equal(
      plan.sdk.mcpServers,
      undefined,
      "kept out of the runtime identity",
    );
    assert.deepEqual(plan.sdk.allowedTools, ["mcp__foundry"]);
    assert.ok(plan.cliArgs.includes("mcp__foundry"));
    const flag = plan.cliArgs.indexOf("--mcp-config");
    assert.deepEqual(JSON.parse(plan.cliArgs[flag + 1]), {
      mcpServers: plan.mcpServers,
    });
    const naming = buildClaudeLaunchPlan({
      workspacePath: "/tmp",
      session: { ...chat, source: "naming" },
      profile: compatibleProfile({ apiKey: "k" }),
    });
    assert.equal(naming.mcpServers, undefined, "utility sessions get no tools");
    assert.equal(naming.cliArgs.includes("--mcp-config"), false);
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
