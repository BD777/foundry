// prepareSessionConnectors / withSessionConnectors (connectors/index.ts):
// what a real session's environment gets for a device-held connector it may
// use, from the one place that builds it. A gh the device installed in
// ~/.local/bin (outside the PATH sessions get) is found through the device's
// own tool folders, linked into the session's own bin folder in front of its
// PATH, and git's credential helper joins the session's own git settings.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fdy-prepare-home-"));
mkdirSync(join(home, ".local", "bin"), { recursive: true });
writeFileSync(join(home, ".local", "bin", "gh"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
process.env.HOME = home;
process.env.PATH = "/usr/bin:/bin";
const { prepareSessionConnectors, withSessionConnectors } =
  await import("../dist/connectors/index.js");

const session = { id: "sess_prepare_1", source: "chat", role: "chat" };
const use = {
  kind: "github",
  adapter: "github",
  label: "GitHub CLI",
  command: "gh",
  access: "device_login",
};

test("a session's environment gets the linked tool first on PATH and git settings added to its own", async () => {
  const sessionOwn = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.editor",
    GIT_CONFIG_VALUE_0: "true",
  };
  assert.deepEqual(withSessionConnectors(sessionOwn, session.id), sessionOwn);
  const prepared = await prepareSessionConnectors(session, {
    deviceConnectors: [use],
  });
  const env = withSessionConnectors(sessionOwn, session.id);
  const [bin] = env.PATH.split(":");
  assert.match(bin, /session-bin/);
  assert.equal(
    execFileSync("sh", ["-c", "command -v gh"], {
      env,
      encoding: "utf8",
    }).trim(),
    join(bin, "gh"),
  );
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  const git = (key) =>
    execFileSync("git", ["config", "--get", key], {
      env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    }).trim();
  assert.equal(git("core.editor"), "true");
  assert.match(
    git("credential.https://github.com.helper"),
    /gh" auth git-credential$/,
  );
  // Another session has none of it.
  assert.deepEqual(withSessionConnectors(sessionOwn, "sess_other"), sessionOwn);
  prepared.release();
  assert.equal(existsSync(bin), false, "the session's bin folder is removed");
  assert.deepEqual(withSessionConnectors(sessionOwn, session.id), sessionOwn);
});

test("a connector the session may not use links nothing", async () => {
  const prepared = await prepareSessionConnectors(
    { ...session, id: "sess_prepare_2" },
    {
      deviceConnectors: [{ ...use, access: "none" }],
    },
  );
  const env = withSessionConnectors(
    { PATH: "/usr/bin:/bin" },
    "sess_prepare_2",
  );
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.ok(env.GH_CONFIG_DIR);
  // DEV-208: a placeholder, so gh never falls back to the keychain.
  assert.equal(env.GH_TOKEN, "foundry-no-access");
  prepared.release();
});
