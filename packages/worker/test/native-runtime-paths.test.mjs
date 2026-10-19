import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isolatedCodexEnvironment,
  isolatedClaudeEnvironment,
  nativeExecutionPaths,
} from "../dist/runtime-isolation.js";
import {
  nativeExecutionHome,
  nativeSourcePaths,
} from "../dist/native-runtime-paths.js";
import { CodexAppServer } from "../dist/agent-runtime/codex-client.js";
import { authenticateIsolatedCodex } from "../dist/agent-runtime/codex-auth.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    workspace = join(root, "workspace");
  mkdirSync(source);
  mkdirSync(workspace);
  return { root, source, workspace };
}

test("each session owns its configuration while both locate the original history and login", (t) => {
  const { root, source, workspace } = fixture(t);
  for (const runtime of ["codex", "claude"]) {
    const prepare =
      runtime === "codex"
        ? isolatedCodexEnvironment
        : isolatedClaudeEnvironment;
    const key = runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const profile = { id: runtime, runtime, connectionType: "local_login" };
    const env = { HOME: root, [key]: source, FOUNDRY_SESSION_ID: "A" };
    const a = prepare(profile, env, workspace);
    const b = prepare(profile, { ...env, FOUNDRY_SESSION_ID: "B" }, workspace);
    assert.notEqual(a[key], b[key]);
    assert.equal(nativeSourcePaths(runtime, a).credentialHome, source);
    assert.equal(nativeExecutionHome(runtime, a), a[key]);
    assert.equal(prepare(profile, a, workspace)[key], a[key]);
    assert.equal(nativeExecutionPaths(a).ownerId, "A");
    assert.equal(
      realpathSync(join(a[key], runtime === "codex" ? "sessions" : "projects")),
      join(source, runtime === "codex" ? "sessions" : "projects"),
    );
  }
});

test("a diagnostic flag cannot bypass policy, and a compatible connection drops another login's handoff", (t) => {
  const { root, source, workspace } = fixture(t);
  const env = isolatedCodexEnvironment(
    { runtime: "codex", id: "endpoint", connectionType: "openai_compatible" },
    {
      HOME: root,
      CODEX_HOME: source,
      FOUNDRY_SESSION_ID: "A",
      FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
      FOUNDRY_CODEX_AUTH_SOURCE: source,
    },
    workspace,
  );
  assert.notEqual(env.CODEX_HOME, source);
  assert.equal(env.FOUNDRY_CODEX_AUTH_SOURCE, undefined);
  assert.match(
    readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8"),
    /cli_auth_credentials_store = "ephemeral"/,
  );
  assert.match(
    readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8"),
    /memories = false/,
  );
});

test("sandbox preparation stays under its private writable artifact root", (t) => {
  const { root, source, workspace } = fixture(t);
  const sessions = join(root, "scratch", "sessions");
  const env = isolatedClaudeEnvironment(
    { runtime: "claude", id: "claude", connectionType: "anthropic_compatible" },
    {
      HOME: root,
      CLAUDE_CONFIG_DIR: source,
      FOUNDRY_SESSION_ID: "A",
      FOUNDRY_EXECUTION_SESSION_ROOT: sessions,
    },
    workspace,
  );
  assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(sessions + "/"));
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(nativeExecutionPaths(env).sources.dataHome, source);
});

test("explicit source locators are preserved even when the source folder is named native-runtime", () => {
  const source = "/custom/native-runtime/login";
  assert.equal(
    nativeSourcePaths("codex", {
      CODEX_HOME: "/execution",
      FOUNDRY_NATIVE_CODEX_SOURCE_HOME: source,
    }).credentialHome,
    source,
  );
});

test(
  "native API-key handoff leaves no auth file in the execution home",
  { skip: !process.env.TEST_CODEX_AUTH_BIN },
  async (t) => {
    const { root, source, workspace } = fixture(t);
    const key = "synthetic-native-key-no-inference";
    writeFileSync(
      join(source, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }),
    );
    const env = isolatedCodexEnvironment(
      { runtime: "codex", id: "official", connectionType: "local_login" },
      {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: source,
        FOUNDRY_SESSION_ID: "auth",
      },
      workspace,
    );
    const client = new CodexAppServer(
      process.env.TEST_CODEX_AUTH_BIN,
      env,
      workspace,
    );
    try {
      await authenticateIsolatedCodex(
        client,
        env,
        process.env.TEST_CODEX_AUTH_BIN,
      );
      assert.equal(existsSync(join(env.CODEX_HOME, "auth.json")), false);
      assert.equal(
        JSON.stringify(nativeExecutionPaths(env)).includes(key),
        false,
      );
      assert.equal(
        JSON.parse(readFileSync(join(source, "auth.json"))).OPENAI_API_KEY,
        key,
      );
    } finally {
      client.close();
    }
  },
);

test("an ordinary custom directory named native-runtime is a source, and service installation recovers explicit origins", async () => {
  const { nativeServiceHome, withNativeSourceOverrides } =
    await import("../dist/native-runtime-paths.js");
  const custom = "/custom/native-runtime/login";
  assert.equal(
    nativeSourcePaths("codex", { CODEX_HOME: custom }).credentialHome,
    custom,
  );
  assert.equal(nativeServiceHome("codex", { CODEX_HOME: custom }), custom);
  const managed = {
    CODEX_HOME: "/home/me/.foundry/native-runtime/owners/codex/session",
    FOUNDRY_NATIVE_CODEX_SOURCE_HOME: custom,
  };
  assert.equal(nativeServiceHome("codex", managed), custom);
  const selected = withNativeSourceOverrides(managed, {
    CODEX_HOME: "/other/account",
  });
  assert.equal(
    nativeSourcePaths("codex", selected).credentialHome,
    "/other/account",
  );
});
