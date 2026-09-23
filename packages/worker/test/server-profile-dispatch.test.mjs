import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// The profiles module resolves ~/.foundry/agent-profiles.local.json once at
// import time, so the empty home has to exist before the dynamic import: these
// tests describe a device that has no local row for the server's profile.
const home = mkdtempSync(resolve(tmpdir(), "foundry-server-profile-"));
const originalHome = process.env.HOME;
process.env.HOME = home;
after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const {
  profileConfigForSession,
  profileHasAuth,
  profileRuntimeEnvironment,
  profileSecretPlacement,
  withDispatchCredential,
} = await import("../dist/profiles.js");

const definition = {
  id: "prof_server_1",
  runtime: "claude",
  label: "Relay",
  connectionType: "anthropic_compatible",
  baseUrl: "https://relay.example/v1",
  model: "relay-sonnet",
  promptPrefix: "Answer in French.",
  claudeEffort: "high",
  hasCredential: true,
  updatedAtLabel: "just now",
};

const session = {
  id: "ses_1",
  provider: "claude",
  profileId: definition.id,
  prompt: "hello",
};

test("a dispatched definition runs on its own endpoint with no local row", () => {
  const profile = withDispatchCredential(
    profileConfigForSession("/tmp/workspace", session, definition),
    "server-key",
  );

  assert.equal(profile.id, definition.id);
  assert.equal(profile.baseUrl, definition.baseUrl);
  assert.equal(profile.model, definition.model);
  assert.equal(profile.connectionType, "anthropic_compatible");
  assert.equal(profile.promptPrefix, definition.promptPrefix);
  assert.equal(profile.claudeEffort, "high");

  // The credential and the endpoint travel together into the runtime env, so
  // the key can only ever reach the profile's own base URL.
  const env = profileRuntimeEnvironment(profile);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "server-key");
  assert.equal(env.ANTHROPIC_BASE_URL, definition.baseUrl);
  assert.equal(env.ANTHROPIC_MODEL, definition.model);
});

test("an unresolvable profile id fails instead of falling back to local login", () => {
  assert.throws(
    () => profileConfigForSession("/tmp/workspace", session),
    (error) => {
      assert.match(error.message, /prof_server_1/);
      return true;
    },
  );

  // A fingerprint is no backdoor either: the old resolution order would have
  // landed on the same-runtime local login, which has no base URL, and the
  // dispatched key would then have gone to the vendor's public endpoint.
  assert.throws(() =>
    profileConfigForSession("/tmp/workspace", {
      ...session,
      profileFingerprint: "claude:local_login",
    }),
  );
});

test("a session without a profile id still resolves the runtime default", () => {
  const profile = profileConfigForSession("/tmp/workspace", {
    id: "ses_2",
    provider: "codex",
    prompt: "hello",
  });
  assert.equal(profile.id, "codex_local");
  assert.equal(profile.connectionType, "local_login");
});

test("a remote profile with no local key defers the auth verdict to the server", () => {
  assert.equal(
    profileHasAuth(
      {
        id: "prof_server_1",
        runtime: "claude",
        label: "Relay",
        connectionType: "anthropic_compatible",
        baseUrl: "https://relay.example/v1",
      },
      [],
    ),
    true,
  );
});

test("an env profile with no key is still the daemon's own verdict", (t) => {
  const cleared = { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined };
  for (const key of Object.keys(cleared)) {
    cleared[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(cleared))
      if (value !== undefined) process.env[key] = value;
  });

  assert.equal(
    profileHasAuth(
      {
        id: "prof_env_1",
        runtime: "codex",
        label: "Env",
        connectionType: "env",
      },
      [],
    ),
    false,
  );
});

test("secretStored follows the credential, not the file it came from", () => {
  const dispatched = profileConfigForSession(
    "/tmp/workspace",
    session,
    definition,
  );
  assert.equal(profileSecretPlacement(dispatched), "server");

  const local = {
    id: "prof_local_1",
    runtime: "claude",
    label: "Local relay",
    connectionType: "anthropic_compatible",
    baseUrl: "https://local.example/v1",
    apiKey: "local-key",
  };
  assert.equal(profileSecretPlacement(local), "local");
  assert.equal(
    profileSecretPlacement(withDispatchCredential(local, "server-key")),
    "server",
  );
  assert.equal(
    profileSecretPlacement(withDispatchCredential(local, undefined)),
    "local",
  );
});
