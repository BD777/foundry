import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isolatedCodexEnvironment,
  isolatedClaudeEnvironment,
} from "../dist/runtime-isolation.js";
import { authenticateIsolatedCodex } from "../dist/agent-runtime/codex-auth.js";
import { codexProfileConfig } from "../dist/runner/codex-options.js";
import {
  claudeSessionOptions,
  claudeWorkspaceInstructions,
} from "../dist/session-policy.js";
import {
  baseProcessEnvironment,
  profileRuntimeEnvironment,
} from "../dist/profiles.js";

test("Codex owns config while native history stays resumable and credentials stay at their source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "native"),
    workspace = join(root, "workspace");
  mkdirSync(source);
  mkdirSync(workspace);
  writeFileSync(
    join(source, "config.toml"),
    'model_catalog_json="/untrusted/catalog.json"\nmodel_context_window=300000\n',
  );
  writeFileSync(
    join(source, "auth.json"),
    JSON.stringify({ tokens: { refresh_token: "must-not-copy" } }),
  );
  const profile = {
    runtime: "codex",
    id: "gateway",
    connectionType: "openai_compatible",
    baseUrl: "https://selected.example",
    codexModelProvider: "legacy",
    contextWindow: {
      tokens: 872000,
      model: "flux/gpt-6-astra",
      source: "setting",
    },
  };
  const env = isolatedCodexEnvironment(
    profile,
    { HOME: root, CODEX_HOME: source },
    workspace,
  );
  assert.notEqual(env.CODEX_HOME, source);
  assert.equal(env.FOUNDRY_CODEX_AUTH_SOURCE, undefined);
  assert.equal(existsSync(join(env.CODEX_HOME, "auth.json")), false);
  const config = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8");
  assert(!config.includes("model_catalog_json"));
  assert(config.includes('trust_level = "untrusted"'));
  assert.equal(
    realpathSync(join(env.CODEX_HOME, "sessions")),
    join(source, "sessions"),
  );
  assert.equal(codexProfileConfig(profile, {}).model_context_window, 872000);
  assert.equal(
    codexProfileConfig(profile, {}).model_providers.foundry_gateway.base_url,
    "https://selected.example",
  );
  assert(readFileSync(join(source, "config.toml"), "utf8").includes("300000"));
  assert.equal(
    isolatedCodexEnvironment(
      profile,
      { HOME: root, CODEX_HOME: source },
      workspace,
    ).CODEX_HOME,
    env.CODEX_HOME,
  );
  const official = isolatedCodexEnvironment(
    { ...profile, id: "official", connectionType: "local_login" },
    { HOME: root, CODEX_HOME: source },
    workspace,
  );
  assert.equal(official.FOUNDRY_CODEX_AUTH_SOURCE, source);
  assert.notEqual(official.CODEX_HOME, env.CODEX_HOME);
});

test("Codex official login hands off access tokens only and rejects account changes on refresh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "isolated-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jwt = (data) =>
    "x." + Buffer.from(JSON.stringify(data)).toString("base64url") + ".x";
  const tokens = {
    access_token: jwt({ exp: 4102444800 }),
    refresh_token: "never-transfer",
    account_id: "account-one",
    id_token: jwt({
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    }),
  };
  writeFileSync(join(root, "auth.json"), JSON.stringify({ tokens }));
  let sent;
  const client = {
    request: async (method, args) => {
      sent = { method, args };
    },
  };
  await authenticateIsolatedCodex(
    client,
    { FOUNDRY_CODEX_AUTH_SOURCE: root },
    "unused",
  );
  assert.equal(sent.method, "account/login/start");
  assert.equal(sent.args.type, "chatgptAuthTokens");
  assert.equal(sent.args.chatgptAccountId, "account-one");
  assert(!JSON.stringify(sent).includes("never-transfer"));
  writeFileSync(
    join(root, "auth.json"),
    JSON.stringify({ tokens: { ...tokens, account_id: "other-account" } }),
  );
  await assert.rejects(() => client.onRequest("not-auth", {}), /Unsupported/);
  await assert.rejects(
    () => client.onRequest("account/chatgptAuthTokens/refresh", {}),
    /account changed/,
  );
});

test("a Codex home carries the untrusted workspace's AGENTS.md and no plugins", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-instructions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "native"),
    workspace = join(root, "workspace");
  mkdirSync(source);
  mkdirSync(workspace);
  // A workspace that keeps its rules in CLAUDE.md and links AGENTS.md to it.
  writeFileSync(join(workspace, "CLAUDE.md"), "WORKSPACE_RULE");
  symlinkSync("CLAUDE.md", join(workspace, "AGENTS.md"));
  const profile = { runtime: "codex", connectionType: "local_login" };
  const prepare = () =>
    isolatedCodexEnvironment(
      profile,
      { HOME: root, CODEX_HOME: source },
      workspace,
      "sess_instructions",
    );
  const env = prepare();
  const config = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8");
  assert(config.includes('trust_level = "untrusted"'));
  assert(config.includes("plugins = false"));
  assert.equal(
    readFileSync(join(env.CODEX_HOME, "AGENTS.md"), "utf8"),
    "Workspace instructions (AGENTS.md):\nWORKSPACE_RULE\n",
  );
  writeFileSync(join(workspace, "AGENTS.override.md"), "OVERRIDE_RULE");
  assert.match(
    readFileSync(join(prepare().CODEX_HOME, "AGENTS.md"), "utf8"),
    /^Workspace instructions \(AGENTS\.override\.md\):\nOVERRIDE_RULE/,
  );
  rmSync(join(workspace, "AGENTS.override.md"));
  rmSync(join(workspace, "AGENTS.md"));
  assert.equal(existsSync(join(prepare().CODEX_HOME, "AGENTS.md")), false);
});

test("Claude settings and integrations are explicit while workspace instruction files remain admitted", (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "AGENTS.md"), "WORKSPACE_RULE");
  writeFileSync(
    join(root, ".claude/settings.json"),
    JSON.stringify({ env: { ANTHROPIC_MODEL: "wrong" }, hooks: {} }),
  );
  const options = claudeSessionOptions(
    undefined,
    claudeWorkspaceInstructions(root),
  );
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert(options.systemPrompt.append.includes("WORKSPACE_RULE"));
  assert(!options.systemPrompt.append.includes("wrong"));
});

test("ambient runtime knobs cannot override a selected provider", (t) => {
  const keys = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000",
    ANTHROPIC_MODEL: "ambient",
    CODEX_MODEL: "ambient",
    OPENAI_BASE_URL: "https://wrong.example",
    CLAUDE_CODE_OAUTH_TOKEN: "wrong-account",
  };
  const previous = Object.fromEntries(
    Object.keys(keys).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, keys);
  t.after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const profile = {
    runtime: "claude",
    origin: "server",
    connectionType: "anthropic_compatible",
    baseUrl: "https://selected.example",
    model: "chosen",
    apiKey: "selected-key",
  };
  const env = {
    ...baseProcessEnvironment(profile),
    ...profileRuntimeEnvironment(profile),
  };
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(env.CODEX_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_MODEL, "chosen");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://selected.example");
});

test("Claude isolates configuration and preserves native history and credential ownership", (t) => {
  const root = mkdtempSync(join(tmpdir(), "claude-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".claude");
  mkdirSync(source);
  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accountUuid: "alice", organizationUuid: "org" },
      mcpServers: { unselected: { command: "false" } },
    }),
  );
  writeFileSync(
    join(source, ".credentials.json"),
    "REFRESH_TOKEN_MUST_STAY_HERE",
  );
  writeFileSync(
    join(source, "settings.json"),
    JSON.stringify({
      model: "wrong",
      env: { ANTHROPIC_BASE_URL: "https://wrong.example" },
    }),
  );
  const profile = {
    runtime: "claude",
    id: "official",
    connectionType: "local_login",
  };
  const env = isolatedClaudeEnvironment(
    profile,
    { HOME: root, PATH: process.env.PATH },
    root,
  );
  assert.notEqual(env.CLAUDE_CONFIG_DIR, source);
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "");
  assert.equal(
    existsSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json")),
    false,
  );
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
  assert.equal(
    JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, ".claude.json")))
      .mcpServers,
    undefined,
  );
  assert.equal(
    realpathSync(join(env.CLAUDE_CONFIG_DIR, "projects")),
    join(source, "projects"),
  );
  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accountUuid: "bob", organizationUuid: "org" },
    }),
  );
  assert.notEqual(
    isolatedClaudeEnvironment(profile, { HOME: root }, root).CLAUDE_CONFIG_DIR,
    env.CLAUDE_CONFIG_DIR,
  );
  assert.equal(
    readFileSync(join(source, ".credentials.json"), "utf8"),
    "REFRESH_TOKEN_MUST_STAY_HERE",
  );
  const gateway = isolatedClaudeEnvironment(
    { ...profile, id: "gateway", connectionType: "anthropic_compatible" },
    { HOME: root },
    root,
  );
  assert.equal(
    gateway.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    gateway.CLAUDE_CONFIG_DIR,
  );
});

test("a native connection imports only its provider definition, not ambient credentials or execution settings", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "unselected-ambient-key";
  try {
    const profile = {
      runtime: "codex",
      origin: "device",
      connectionType: "openai_compatible",
      id: "relay",
      baseUrl: "https://relay.example",
      codexProviderConfig: {
        name: "relay",
        requires_openai_auth: true,
        http_headers: { "X-Tenant": "selected" },
      },
    };
    const env = baseProcessEnvironment(profile);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const config = codexProfileConfig(profile, env);
    assert.equal(
      config.model_providers.foundry_relay.requires_openai_auth,
      true,
    );
    assert.deepEqual(config.model_providers.foundry_relay.http_headers, {
      "X-Tenant": "selected",
    });
    assert.equal(config.model_providers.foundry_relay.env_key, undefined);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("a changed Codex window starts a handle with the new config while retaining native thread identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-handle-"));
  const command = join(root, "codex");
  writeFileSync(command, "#!/bin/sh\necho codex-cli 0.163.0\n", {
    mode: 0o700,
  });
  const previous = process.env.FOUNDRY_CODEX_BIN;
  process.env.FOUNDRY_CODEX_BIN = command;
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_CODEX_BIN;
    else process.env.FOUNDRY_CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const { openCodexThread } = await import("../dist/runner/codex-thread.js");
  const { activeCodexThreads } = await import("../dist/session-state.js");
  const session = {
    id: "isolation-window",
    workspaceId: "w",
    provider: "codex",
    model: "flux/gpt-6-astra",
    nativeSessionId: "native-window",
  };
  const profile = {
    runtime: "codex",
    id: "gateway-window",
    origin: "server",
    connectionType: "openai_compatible",
    baseUrl: "https://gateway.example",
    contextWindow: { tokens: 400000, model: session.model, source: "setting" },
  };
  const input = {
    workspacePath: tmpdir(),
    session,
    profile,
    env: { CODEX_HOME: tmpdir() },
    emit: async () => {},
    emitSetup: async () => {},
  };
  try {
    const first = await openCodexThread(input);
    assert.equal(first.thread.options.contextWindow.tokens, 400000);
    const next = await openCodexThread({
      ...input,
      profile: {
        ...profile,
        contextWindow: { ...profile.contextWindow, tokens: 872000 },
      },
    });
    assert.notEqual(first.thread, next.thread);
    assert.equal(next.thread.id, "native-window");
    assert.equal(next.thread.config.model_context_window, 872000);
    assert.equal(next.thread.options.contextWindow.tokens, 872000);
    const official = await openCodexThread({
      ...input,
      profile: { ...profile, connectionType: "local_login" },
    });
    assert.equal(official.thread.options.contextWindow, undefined);
    const changedAccount = await openCodexThread({
      ...input,
      env: { CODEX_HOME: join(tmpdir(), "other-account") },
    });
    assert.notEqual(first.thread, changedAccount.thread);
  } finally {
    activeCodexThreads.clear();
  }
});
