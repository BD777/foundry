import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeLaunchPlan,
  codexSessionTools,
  foundryClaudeSettings,
  resolvedClaudeCredential,
} from "../dist/session-policy.js";

const session = { id: "sess_1", prompt: "hello", workspaceId: "ws_1" };

// The browser is offered once installed; the launcher's scratch state root
// holds the install marker for these tests.
function markBrowserInstalled() {
  const version = JSON.parse(
    readFileSync(
      new URL("../node_modules/@playwright/mcp/package.json", import.meta.url),
      "utf8",
    ),
  ).version;
  const marker = join(
    process.env.FOUNDRY_STATE_ROOT,
    "browsers",
    `.installed-${version}`,
  );
  mkdirSync(join(process.env.FOUNDRY_STATE_ROOT, "browsers"), {
    recursive: true,
  });
  writeFileSync(marker, "test");
  return () => rmSync(marker, { force: true });
}

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

test("sessions with an orchestration identity get the Foundry tools with their own token", async (t) => {
  t.after(markBrowserInstalled());
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
    assert.deepEqual(plan.mcpServers.foundry, {
      type: "http",
      url: "http://127.0.0.1:31982/api/mcp",
      headers: { Authorization: "Bearer token-for-sess_tools" },
    });
    assert.equal(plan.mcpServers.browser.type, "stdio");
    assert.ok(plan.mcpServers.browser.args.includes("--isolated"));
    assert.equal(
      plan.sdk.mcpServers,
      undefined,
      "kept out of the runtime identity",
    );
    assert.deepEqual(plan.sdk.allowedTools, ["mcp__foundry", "mcp__browser"]);
    assert.ok(plan.cliArgs.includes("mcp__foundry,mcp__browser"));
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
  assert.deepEqual(
    Object.keys(anonymous.mcpServers),
    ["browser"],
    "no token, no Foundry tools; the browser needs none",
  );
});

test("Codex sessions get the same pre-approved Foundry tools and browser; the token stays in their env", async (t) => {
  const unmark = markBrowserInstalled();
  t.after(unmark);
  const { registerSessionAmbientEnv } =
    await import("../dist/session-ambient.js");
  const unregister = registerSessionAmbientEnv("sess_codex_tools", {
    serverURL: "http://127.0.0.1:31982",
    sessionToken: "token-for-sess_codex_tools",
    workspaceID: "ws_1",
  });
  try {
    const chat = { ...session, id: "sess_codex_tools", source: "chat" };
    const tools = codexSessionTools(chat, "/workspace");
    assert.deepEqual(tools.config.mcp_servers.foundry, {
      url: "http://127.0.0.1:31982/api/mcp",
      bearer_token_env_var: "FOUNDRY_SESSION_TOKEN",
      default_tools_approval_mode: "approve",
    });
    const browser = tools.config.mcp_servers.browser;
    assert.equal(browser.default_tools_approval_mode, "approve");
    assert.ok(
      browser.args.includes(
        "/workspace/.foundry/attachments/browser/sess_codex_tools",
      ),
      "screenshots land in this session's attachments",
    );
    assert.equal(
      JSON.stringify(tools).includes("token-for-sess_codex_tools"),
      false,
      "the token stays in the environment, never in config or argv",
    );
    assert.ok(
      tools.cliArgs.includes(
        'mcp_servers.foundry.bearer_token_env_var="FOUNDRY_SESSION_TOKEN"',
      ),
    );
    assert.ok(
      tools.cliArgs.includes(
        'mcp_servers.browser.default_tools_approval_mode="approve"',
      ),
    );
    assert.equal(
      codexSessionTools({ ...chat, source: "naming" }, "/workspace"),
      undefined,
      "utility sessions get no tools",
    );
    assert.equal(
      codexSessionTools({ ...chat, issueId: "iss_1" }, "/workspace").config
        .mcp_servers.browser,
      undefined,
      "no browser inside the Issue sandbox yet",
    );
    assert.ok(
      tools.cliArgs.some((arg) =>
        arg.startsWith("mcp_servers.browser.env.PLAYWRIGHT_BROWSERS_PATH="),
      ),
      "nested tables become dotted keys Codex can parse",
    );
    unmark();
    assert.equal(
      codexSessionTools(chat, "/workspace").config.mcp_servers.browser,
      undefined,
      "an uninstalled browser is not offered",
    );
  } finally {
    unregister();
  }
});
