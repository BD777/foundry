// What a device-held connector gives a session (connectors/device-held.ts
// sessionSetup, session-environment.ts, github.ts sessionEnvironment): the
// tool linked into the session's own bin folder, git's credential helper in
// the session's environment only, nothing in the person's global git
// configuration, and the status checks made in those same environments.
// A fake gh stands in for the real one; git is the real git.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubAdapter, isolatedGhToken } from "../dist/connectors/github.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import {
  applySessionSetup,
  mergeEnvironment,
} from "../dist/connectors/session-environment.js";

const catalog = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
);
const descriptor = catalog.find((x) => x.kind === "github");
const use = {
  kind: "github",
  adapter: "github",
  label: "GitHub CLI",
  command: "gh",
  access: "device_login",
};

// gh signed in as octo-cat when its configuration folder has hosts.yml.
// Like the real gh (2.40+): a token in GH_TOKEN is used instead of any
// login; without one and without hosts.yml it still falls back to the
// keychain, which holds the token while the person is signed in
// (FAKE_GH_DEFAULT has hosts.yml); status then reads as signed out, but
// `auth token` and the credential helper hand the token out.
// FAKE_GH_IGNORE_ENV_TOKEN models a gh that reads the keychain regardless.
const fakeGh = `#!/bin/sh
dir="\${GH_CONFIG_DIR:-$FAKE_GH_DEFAULT}"
[ -n "$FAKE_GH_IGNORE_ISOLATION" ] && dir="$FAKE_GH_DEFAULT"
login=0
[ -f "$dir/hosts.yml" ] && login=1
env_token="$GH_TOKEN"
[ -n "$FAKE_GH_IGNORE_ENV_TOKEN$FAKE_GH_IGNORE_ISOLATION" ] && env_token=""
token=""
if [ -n "$env_token" ]; then token="$env_token"
elif [ $login = 1 ]; then token=gho_FAKETOKEN
elif [ -f "$FAKE_GH_DEFAULT/hosts.yml" ]; then token=gho_FAKETOKEN
fi
case "$1" in
  --version) echo "gh version 2.67.0 (2025-02-11)"; echo "https://github.com/cli/cli/releases/tag/v2.67.0" ;;
  auth)
    case "$2" in
      status)
        if [ -n "$env_token" ]; then
          echo "github.com"; echo "  X Failed to log in to github.com using token (GH_TOKEN)"; echo "  - The token in GH_TOKEN is invalid."; exit 1
        fi
        if [ $login = 1 ]; then echo "github.com"; echo "  ✓ Logged in to github.com account octo-cat (keyring)"; exit 0; fi
        echo "You are not logged into any GitHub hosts." >&2; exit 1 ;;
      token)
        [ -n "$token" ] && { echo "$token"; exit 0; }
        echo "no oauth token found for github.com" >&2; exit 1 ;;
      git-credential)
        [ -n "$FAKE_GH_NO_HELPER" ] && exit 1
        cat > /dev/null
        if [ -n "$token" ]; then printf 'username=octo-cat\\npassword=%s\\n' "$token"; exit 0; fi
        exit 1 ;;
    esac ;;
esac
exit 0
`;

// The system tools these tests run, and nothing else: a CI runner (or a
// developer's machine) has a real gh in /usr/bin, which must not be found.
const systemBin = mkdtempSync(join(tmpdir(), "fdy-session-env-sys-"));
for (const tool of ["sh", "git", "cat", "env"]) {
  const found = execFileSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  }).trim();
  symlinkSync(found, join(systemBin, tool));
}
process.on("exit", () => rmSync(systemBin, { recursive: true, force: true }));

function world(t) {
  const root = mkdtempSync(join(tmpdir(), "fdy-session-env-"));
  const outside = join(root, "outside"); // not on any PATH
  const ghHome = join(root, "gh-home");
  const home = join(root, "home");
  for (const dir of [outside, ghHome, home]) mkdirSync(dir);
  writeFileSync(join(outside, "gh"), fakeGh, { mode: 0o755 });
  writeFileSync(join(ghHome, "hosts.yml"), "github.com: {}\n");
  const globalConfig = "[user]\n\tname = Someone\n";
  writeFileSync(join(home, ".gitconfig"), globalConfig);
  const saved = { ...process.env };
  process.env.PATH = systemBin;
  process.env.HOME = home;
  process.env.FAKE_GH_DEFAULT = ghHome;
  for (const name of [
    "FAKE_GH_NO_HELPER",
    "FAKE_GH_IGNORE_ISOLATION",
    "FAKE_GH_IGNORE_ENV_TOKEN",
    "GH_CONFIG_DIR",
  ])
    delete process.env[name];
  t.after(() => {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  const runtime = new DeviceHeldConnectors({
    adapters: { github: githubAdapter },
    managedBin: () => join(root, "managed"),
    toolDirs: [outside],
  });
  return { root, outside, home, ghHome, globalConfig, runtime };
}

/** Runs a shell line the way a process of a session with `env` does. */
function inSession(env, line) {
  return execFileSync("sh", ["-c", line], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * What `git clone` asks first: the credential for github.com. By default
 * only the session's configuration answers; `withGlobal` also reads the
 * person's global configuration (HOME/.gitconfig), as a session's git does.
 * Nothing is asked either way.
 */
function gitCredential(env, { withGlobal = false } = {}) {
  try {
    const answer = execFileSync("git", ["credential", "fill"], {
      env: {
        ...env,
        ...(withGlobal ? {} : { GIT_CONFIG_GLOBAL: "/dev/null" }),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
      },
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return /^password=.+$/m.test(answer) ? answer : "";
  } catch {
    return "";
  }
}

test("a gh the device installed outside the session's PATH is linked into the session's own bin folder", (t) => {
  const { root, outside, runtime } = world(t);
  const bin = join(root, "session-bin");
  const setup = runtime.sessionSetup([use], bin);
  assert.deepEqual(setup.pathDirs, [bin]);
  // The session's gh is Foundry's guard, which runs the device's gh for
  // everything but changing its login (DEV-136).
  assert.match(
    readFileSync(readlinkSync(join(bin, "gh")), "utf8"),
    new RegExp(`exec '${join(outside, "gh")}' "\\$@"`),
  );
  const env = applySessionSetup({ PATH: systemBin }, setup);
  assert.equal(env.PATH, `${bin}:${systemBin}`);
  assert.equal(inSession(env, "command -v gh"), join(bin, "gh"));
  assert.match(inSession(env, "gh --version"), /gh version 2\.67\.0/);
  // Without the session's setup the same PATH finds nothing.
  assert.throws(() => inSession({ PATH: systemBin }, "command -v gh"));
  // The shared tools folder and the device's PATH are not touched.
  assert.equal(existsSync(join(root, "managed", "gh")), false);
});

test("git gets the gh login's credential in the session, from its environment only", (t) => {
  const { root, home, globalConfig, runtime } = world(t);
  const setup = runtime.sessionSetup([use], join(root, "bin"));
  assert.equal(setup.environment.GIT_CONFIG_COUNT, "1");
  assert.equal(
    setup.environment.GIT_CONFIG_KEY_0,
    "credential.https://github.com.helper",
  );
  assert.match(
    setup.environment.GIT_CONFIG_VALUE_0,
    /^!".*\/outside\/gh" auth git-credential$/,
  );
  const env = applySessionSetup(
    {
      PATH: systemBin,
      HOME: home,
      FAKE_GH_DEFAULT: process.env.FAKE_GH_DEFAULT,
    },
    setup,
  );
  assert.match(gitCredential(env), /^password=gho_FAKETOKEN$/m);
  // The person's own git configuration is as it was: nothing was written.
  assert.equal(readFileSync(join(home, ".gitconfig"), "utf8"), globalConfig);
  assert.equal(
    existsSync(join(home, ".config", "git")),
    false,
    "no other global file either",
  );
});

test("a session that may not use the login gets neither gh nor a credential", (t) => {
  const { root, home, runtime } = world(t);
  const setup = runtime.sessionSetup(
    [
      // As the server sends it for a member's session without a grant: GitHub
      // declares no isolation variables, the adapter isolates with its own.
      { ...use, access: "none" },
    ],
    join(root, "bin"),
  );
  assert.deepEqual(setup.pathDirs, []);
  assert.ok(setup.environment.GH_CONFIG_DIR);
  assert.equal(setup.environment.GH_TOKEN, isolatedGhToken);
  assert.deepEqual(readdirSync(setup.environment.GH_CONFIG_DIR), []);
  const gh = join(root, "outside", "gh");
  // The person's global git configuration hands out github.com credentials
  // two ways: gh's helper (`gh auth setup-git`) and a keychain-like helper.
  writeFileSync(
    join(home, ".gitconfig"),
    `[credential "https://github.com"]\n\thelper = !"${gh}" auth git-credential\n` +
      `[credential]\n\thelper = "!f() { cat >/dev/null; echo username=x; echo password=gho_KEYCHAIN; }; f"\n`,
  );
  const base = {
    PATH: systemBin,
    HOME: home,
    FAKE_GH_DEFAULT: process.env.FAKE_GH_DEFAULT,
  };
  // Without the isolation both routes hand out the login.
  assert.match(gitCredential(base, { withGlobal: true }), /password=gho_/);
  const env = applySessionSetup(base, setup);
  assert.throws(() => inSession(env, "command -v gh"));
  // gh run by its path finds no configuration, and the keychain stays shut:
  // all it has is the placeholder GitHub refuses.
  assert.equal(inSession(env, `"${gh}" auth token`), isolatedGhToken);
  assert.throws(() => inSession(env, `"${gh}" auth status`));
  // git reads the global configuration, but the isolation empties the
  // helpers it collected for github.com.
  assert.equal(gitCredential(env, { withGlobal: true }), "");
});

test("git settings of the session and of its connectors add up", () => {
  const merged = mergeEnvironment(
    {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "c.d",
      GIT_CONFIG_VALUE_1: "2",
      OTHER: "kept",
    },
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "e.f",
      GIT_CONFIG_VALUE_0: "3",
      NEW: "x",
    },
  );
  assert.equal(merged.GIT_CONFIG_COUNT, "3");
  assert.deepEqual(
    [0, 1, 2].map((i) => [
      merged[`GIT_CONFIG_KEY_${i}`],
      merged[`GIT_CONFIG_VALUE_${i}`],
    ]),
    [
      ["a.b", "1"],
      ["c.d", "2"],
      ["e.f", "3"],
    ],
  );
  assert.equal(merged.OTHER, "kept");
  assert.equal(merged.NEW, "x");
});

test("signing in to GitHub no longer writes the person's global git configuration", async (t) => {
  const { root, home, globalConfig } = world(t);
  const script = join(root, "login");
  writeFileSync(
    script,
    `#!/bin/sh\necho "! First copy your one-time code: AB12-CD34"\necho "Open this URL to continue in your web browser: https://github.com/login/device"\nsleep 0.3\nexit 0\n`,
    { mode: 0o755 },
  );
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  run.spawn = (args) => {
    calls.push(`spawn ${args.join(" ")}`);
    return spawn(script, [], { stdio: ["pipe", "pipe", "pipe"] });
  };
  const step = await githubAdapter.beginSignIn(run);
  assert.equal(step.status, "pending");
  let polled = await githubAdapter.pollSignIn();
  for (let i = 0; i < 50 && polled.status === "pending"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    polled = await githubAdapter.pollSignIn();
  }
  assert.equal(polled.status, "complete");
  assert.equal(
    calls.some((call) => /setup-git/.test(call)),
    false,
    calls.join("\n"),
  );
  assert.equal(readFileSync(join(home, ".gitconfig"), "utf8"), globalConfig);
});

test("status separates signed in from usable in a session, and checks the isolation", async (t) => {
  const { runtime } = world(t);
  const read = async () =>
    (
      await runtime.handle({
        action: "status",
        connector: descriptor,
        fresh: true,
      })
    ).state;
  const ok = await read();
  assert.equal(ok.signedIn, true);
  assert.equal(ok.installed, true);
  assert.equal(ok.sessionCheck.usable, true, JSON.stringify(ok.sessionCheck));
  assert.equal(ok.sessionCheck.isolationHolds, true);
  assert.equal(ok.sessionCheck.reason, undefined);
  assert.ok(ok.sessionCheck.checkedAt);

  // Signed in, but git gets no credential from gh in a session.
  process.env.FAKE_GH_NO_HELPER = "1";
  const broken = await read();
  assert.equal(broken.signedIn, true);
  assert.equal(broken.sessionCheck.usable, false);
  assert.match(
    broken.sessionCheck.reason,
    /git gets no github\.com credential/,
  );
  delete process.env.FAKE_GH_NO_HELPER;

  // A gh that keeps its login whatever the isolation says: isolation leaks.
  process.env.FAKE_GH_IGNORE_ISOLATION = "1";
  const leaking = await read();
  assert.equal(leaking.sessionCheck.usable, true);
  assert.equal(leaking.sessionCheck.isolationHolds, false);
  assert.match(
    leaking.sessionCheck.isolationReason,
    /still reads as signed in/,
  );
  // What the check ran in held no token: nothing of the credential is in the
  // state.
  assert.doesNotMatch(JSON.stringify(leaking), /gho_/);
  delete process.env.FAKE_GH_IGNORE_ISOLATION;

  // A gh that reads as signed out under the isolation but still takes the
  // token from the keychain (the macOS leak): reported, nothing of it kept.
  process.env.FAKE_GH_IGNORE_ENV_TOKEN = "1";
  const keychain = await read();
  assert.equal(keychain.sessionCheck.usable, true);
  assert.equal(keychain.sessionCheck.isolationHolds, false);
  assert.match(
    keychain.sessionCheck.isolationReason,
    /gh still hands out a github\.com token/,
  );
  assert.doesNotMatch(JSON.stringify(keychain), /gho_/);
  delete process.env.FAKE_GH_IGNORE_ENV_TOKEN;

  // A global helper that hands out a github.com credential on its own is
  // emptied by the isolation, so the check holds.
  writeFileSync(
    join(process.env.HOME, ".gitconfig"),
    `[credential]\n\thelper = "!f() { cat >/dev/null; echo username=x; echo password=gho_KEYCHAIN; }; f"\n`,
  );
  const withKeychainHelper = await read();
  assert.equal(withKeychainHelper.sessionCheck.isolationHolds, true);
});

test("signed-out connectors report no session check", async (t) => {
  const { runtime, ghHome } = world(t);
  writeFileSync(join(ghHome, "hosts.yml.off"), "");
  process.env.FAKE_GH_DEFAULT = join(ghHome, "nowhere");
  const state = (
    await runtime.handle({
      action: "status",
      connector: descriptor,
      fresh: true,
    })
  ).state;
  assert.equal(state.signedIn, false);
  assert.equal(state.sessionCheck, undefined);
});

// A connector an extension provides: the same runtime links its tool, and
// the same checks read the login with the isolation variables set. What
// the extension answers there is what a session that may not use it sees.
test("the checks apply to an extension's connector, and report a login that still reads as signed in under isolation", async (t) => {
  const { root, outside } = world(t);
  writeFileSync(join(outside, "corpcli"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const corp = {
    kind: "corpcli",
    label: "corpcli",
    holding: "device_held",
    adapter: "extension:corp",
    tool: { command: "corpcli", source: "device" },
    isolationEnv: { CORPCLI_PROFILE: "foundry-no-login" },
  };
  let leak;
  const adapter = {
    name: "extension:corp",
    runEnvironment: {},
    clearEnvironment: [],
    async readState(environment) {
      const isolated = environment?.CORPCLI_PROFILE === "foundry-no-login";
      return {
        installed: true,
        installSource: "device",
        version: "1.0.0",
        reading: { signedIn: !isolated || leak === "login" },
        authorizations: [
          {
            id: "lark",
            revision: 1,
            status:
              !isolated || leak === "authorization" ? "ready" : "needs_auth",
          },
        ],
      };
    },
  };
  const runtime = new DeviceHeldConnectors({
    adapters: {},
    extensionAdapter: () => adapter,
    managedBin: () => join(root, "managed"),
    toolDirs: [outside],
  });
  const read = async () =>
    (await runtime.handle({ action: "status", connector: corp, fresh: true }))
      .state;
  const holds = await read();
  assert.equal(holds.sessionCheck.usable, true, JSON.stringify(holds));
  assert.equal(holds.sessionCheck.isolationHolds, true);
  leak = "authorization";
  const authorization = await read();
  assert.equal(authorization.sessionCheck.isolationHolds, false);
  assert.match(
    authorization.sessionCheck.isolationReason,
    /authorization as ready/,
  );
  leak = "login";
  const login = await read();
  assert.equal(login.sessionCheck.isolationHolds, false);
  assert.match(login.sessionCheck.isolationReason, /still reads as signed in/);

  // The tool is linked for a session that may use it, whatever adapter.
  const bin = join(root, "extension-bin");
  const setup = runtime.sessionSetup(
    [
      {
        kind: "corpcli",
        adapter: "extension:corp",
        label: "corpcli",
        command: "corpcli",
        access: "device_login",
      },
    ],
    bin,
  );
  assert.deepEqual(setup.pathDirs, [bin]);
  assert.equal(readlinkSync(join(bin, "corpcli")), join(outside, "corpcli"));
});
