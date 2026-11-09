// Bundle rollouts on the worker (docs/skills.md, Bundle 版本): a tool
// version is staged without moving bin/<name>, checked from its own version
// folder (in the session environment of the connector's account), made
// current or removed; a session runs the versions it was pinned to, whatever
// bin/<name> points at later.
import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(join(tmpdir(), "tools-root-"));
process.env.HOME = mkdtempSync(join(tmpdir(), "rollout-home-"));
const {
  activateTool,
  installTool,
  managedToolVersions,
  managedToolsBin,
  removeToolVersion,
  toolVersionEntry,
} = await import("../dist/skills/managed-tools.js");
const { checkTool } = await import("../dist/skills/tool-check.js");
const { prepareSessionTools, sessionToolsFolder, reapSessionTools } =
  await import("../dist/skills/session-tools.js");
const { prepareConnectorCheck } = await import("../dist/connectors/index.js");
const { sessionEnvironment } =
  await import("../dist/session/session-ambient.js");
const { availableDaemonCapabilities } =
  await import("../dist/daemon/workspace-ops.js");

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "x64" ? "amd64" : "arm64";

/** Writes `<root>/<name>/<version>/<name>` as a script, not current. */
function placeVersion(name, version, script) {
  const entry = toolVersionEntry(name, version);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return entry;
}

function tarball(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "tool-src-"));
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  const out = join(mkdtempSync(join(tmpdir(), "tool-tar-")), "a.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFileSync(out);
}

async function serve(routes) {
  const server = createServer((request, response) => {
    const body = routes[request.url];
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("the worker announces bundle rollouts", () => {
  assert.ok(availableDaemonCapabilities().includes("bundle_rollout_v1"));
});

test("a staged release stays out of bin until activated, and only a version that is not current is removed", async () => {
  const releases = {};
  for (const version of ["v2.0.0", "v2.1.0"]) {
    const archive = tarball("staged-tool", `#!/bin/sh\necho ${version}\n`);
    releases[`/${version}.tar.gz`] = archive;
    releases[`/${version}.sums`] =
      `${createHash("sha256").update(archive).digest("hex")}  staged-tool_${os}-${arch}.tar.gz\n`;
  }
  const { server, origin } = await serve(releases);
  const spec = (version) => ({
    name: "staged-tool",
    version,
    assets: [
      {
        os,
        arch,
        name: `staged-tool_${os}-${arch}.tar.gz`,
        url: `${origin}/${version}.tar.gz`,
      },
    ],
    checksumsUrl: `${origin}/${version}.sums`,
  });
  const link = join(managedToolsBin(), "staged-tool");
  try {
    await installTool(spec("v2.0.0"), { allowedOrigins: [origin] });
    assert.equal(readlinkSync(link), "../staged-tool/v2.0.0/staged-tool");

    await installTool(spec("v2.1.0"), {
      allowedOrigins: [origin],
      activate: false,
    });
    assert.equal(readlinkSync(link), "../staged-tool/v2.0.0/staged-tool");
    assert.equal(managedToolVersions()["staged-tool"], "v2.0.0");
    assert.equal(
      execFileSync(toolVersionEntry("staged-tool", "v2.1.0")).toString(),
      "v2.1.0\n",
    );

    activateTool("staged-tool", "v2.1.0");
    assert.equal(readlinkSync(link), "../staged-tool/v2.1.0/staged-tool");
    assert.equal(execFileSync(link).toString(), "v2.1.0\n");

    assert.throws(
      () => removeToolVersion("staged-tool", "v2.1.0"),
      /is the current version/,
    );
    removeToolVersion("staged-tool", "v2.0.0");
    assert.equal(
      existsSync(join(process.env.FOUNDRY_TOOLS_ROOT, "staged-tool", "v2.0.0")),
      false,
    );
    // Removing again (a retried rollback) is not an error.
    removeToolVersion("staged-tool", "v2.0.0");
    assert.throws(
      () => activateTool("staged-tool", "v2.0.0"),
      /is not installed on this device/,
    );
    assert.throws(
      () => activateTool("../etc", "v1"),
      /invalid tool name or version/,
    );
    assert.equal(readlinkSync(link), "../staged-tool/v2.1.0/staged-tool");
  } finally {
    server.close();
  }
});

const appHandle = "fsg_Y2hlY2stYXBwLWhhbmRsZS0wMTIzNDU2Nzg5YWJjZGVm";
const userHandle = "fsu_Y2hlY2stdXNlci1oYW5kbGUtMDEyMzQ1Njc4OWFiY2RlZg";

function material() {
  return {
    accountId: "xacc_check",
    provider: "feishu",
    label: "Work Feishu",
    tool: "feishu-cli",
    profileName: "foundry-chk-0a1b2c3d4e",
    clientId: "cli_app",
    gateway: { path: "/api/feishu-gw", appHandle, userHandle },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: "offline_access",
    subject: "ou_1",
  };
}

const fakeFeishuCli = (version) => `
case "$1" in
  --version) echo "feishu-cli version ${version}" ;;
  auth)
    dir="$HOME/.feishu-cli/profiles/$FEISHU_PROFILE"
    [ -f "$dir/config.yaml" ] || { echo "no profile $FEISHU_PROFILE" >&2; exit 3; }
    echo "which=$(command -v feishu-cli)"
    cat "$dir/token.json"
    echo "status ok" ;;
  api)
    dir="$HOME/.feishu-cli/profiles/$FEISHU_PROFILE"
    [ -f "$dir/config.yaml" ] || { echo "no profile $FEISHU_PROFILE" >&2; exit 3; }
    printf '{"code":0,"data":{"name":"Alice Example","open_id":"ou_0123456789abcdef","which":"%s"}}\n' "$(command -v feishu-cli)" ;;
  broken) echo "unknown subcommand broken" >&2; exit 2 ;;
esac`;

const options = {
  prepareEnvironment: (payload) =>
    prepareConnectorCheck(payload.externalAccounts ?? [], {
      forwarder: async () => ({ baseURL: "http://127.0.0.1:45678" }),
      log: () => {},
    }),
};

test("check_tool runs the staged version's own program, in the account's session environment, and cleans up", async () => {
  placeVersion("feishu-cli", "v1.41.0", fakeFeishuCli("1.41.0"));
  activateTool("feishu-cli", "v1.41.0");
  const staged = placeVersion("feishu-cli", "v1.44.0", fakeFeishuCli("1.44.0"));
  const profile = join(
    process.env.HOME,
    ".feishu-cli",
    "profiles",
    material().profileName,
  );

  const checked = await checkTool(
    {
      tool: { name: "feishu-cli", version: "v1.44.0" },
      commands: [
        { args: ["auth", "status"], expect: "status ok", result: "status" },
        { args: ["auth", "refresh"], result: "refresh" },
        { args: ["api", "user_info"], result: "read", show: "data.which" },
      ],
      externalAccounts: [material()],
    },
    options,
  );
  assert.equal(checked.error, undefined);
  // One line per step: its kind and value, never a passed step's output.
  assert.deepEqual(
    checked.steps.map((step) => [
      step.name,
      step.state,
      step.kind,
      step.value,
      step.detail,
    ]),
    [
      ["feishu-cli --version", "passed", "version", "1.44.0", undefined],
      ["feishu-cli auth status", "passed", "status", undefined, undefined],
      ["feishu-cli auth refresh", "passed", "refresh", undefined, undefined],
      // The staged folder comes first on PATH: the command ran v1.44.0.
      ["feishu-cli api user_info", "passed", "read", staged, undefined],
    ],
  );
  assert.equal(
    readlinkSync(join(managedToolsBin(), "feishu-cli")),
    "../feishu-cli/v1.41.0/feishu-cli",
  );
  // The bin link still names v1.41.0, and nothing of the account leaves
  // the device: no stand-in, no output.
  assert.ok(!JSON.stringify(checked).includes(userHandle));
  assert.ok(!JSON.stringify(checked).includes("ou_0123456789abcdef"));
  assert.equal(existsSync(profile), false);

  // The current version does not report the target version.
  const wrong = await checkTool(
    {
      tool: { name: "feishu-cli", version: "v1.41.1" },
      commands: [{ args: ["auth", "status"] }],
    },
    options,
  );
  assert.equal(wrong.steps[0].state, "failed");
  assert.match(wrong.steps[0].detail, /not installed on this device/);
  placeVersion("feishu-cli", "v1.41.1", fakeFeishuCli("1.41.0"));
  const mislabelled = await checkTool(
    {
      tool: { name: "feishu-cli", version: "v1.41.1" },
      commands: [{ args: ["auth", "status"] }],
      externalAccounts: [material()],
    },
    options,
  );
  assert.deepEqual(
    mislabelled.steps.map((step) => step.state),
    ["failed", "skipped"],
  );
  assert.match(mislabelled.steps[0].detail, /output lacks "1\.41\.1"/);

  // The first failing command ends the check; the profile is still removed.
  const broken = await checkTool(
    {
      tool: { name: "feishu-cli", version: "v1.44.0" },
      commands: [{ args: ["broken"] }, { args: ["auth", "status"] }],
      externalAccounts: [material()],
    },
    options,
  );
  assert.deepEqual(
    broken.steps.map((step) => [step.name, step.state]),
    [
      ["feishu-cli --version", "passed"],
      ["feishu-cli broken", "failed"],
      ["feishu-cli auth status", "skipped"],
    ],
  );
  assert.match(broken.steps[1].detail, /exit 2: unknown subcommand broken/);
  assert.equal(existsSync(profile), false);

  // An expected text the output lacks fails the step.
  const unexpected = await checkTool(
    {
      tool: { name: "feishu-cli", version: "v1.44.0" },
      commands: [{ args: ["auth", "status"], expect: "user_info ok" }],
      externalAccounts: [material()],
    },
    options,
  );
  assert.equal(unexpected.steps[1].state, "failed");
});

test("check_tool without an account checks the version and skips the commands", async () => {
  placeVersion("lonely-cli", "1.0.0", 'echo "lonely-cli 1.0.0"');
  const checked = await checkTool(
    {
      tool: { name: "lonely-cli", version: "1.0.0" },
      commands: [{ args: ["auth", "status"] }],
    },
    options,
  );
  assert.deepEqual(checked.steps, [
    {
      name: "lonely-cli --version",
      state: "passed",
      kind: "version",
      value: "1.0.0",
    },
    {
      name: "lonely-cli auth status",
      state: "skipped",
      detail: "no account to check with",
    },
  ]);
  const invalid = await checkTool({ tool: { name: "../x", version: "1" } });
  assert.match(invalid.error, /invalid tool name/);
});

test("a session keeps its pinned and snapshotted tool versions while bin moves on", () => {
  placeVersion("pin-a", "1.0.0", "echo a1");
  placeVersion("pin-a", "2.0.0", "echo a2");
  placeVersion("pin-b", "1.0.0", "echo b1");
  placeVersion("pin-b", "2.0.0", "echo b2");
  activateTool("pin-a", "2.0.0");
  activateTool("pin-b", "1.0.0");
  const logs = [];
  const tools = prepareSessionTools(
    "sess_pin/1",
    [
      { name: "pin-a", version: "1.0.0", verified: true },
      { name: "pin-missing", version: "9.9.9" },
    ],
    (line) => logs.push(line),
  );
  const folder = sessionToolsFolder("sess_pin/1");
  assert.ok(folder && existsSync(folder));
  assert.match(logs.join("\n"), /pin-missing 9\.9\.9 is not installed/);

  // An update moves bin; the session's folder does not move.
  activateTool("pin-a", "2.0.0");
  activateTool("pin-b", "2.0.0");
  assert.equal(execFileSync(join(folder, "pin-a")).toString(), "a1\n");
  assert.equal(execFileSync(join(folder, "pin-b")).toString(), "b1\n");
  assert.equal(
    execFileSync(join(managedToolsBin(), "pin-b")).toString(),
    "b2\n",
  );
  assert.throws(
    () => removeToolVersion("pin-b", "1.0.0"),
    /in use by a running session/,
  );

  // The session's PATH has its folder in place of bin.
  const env = sessionEnvironment(
    "/w",
    { id: "p", runtime: "codex", connectionType: "local_login" },
    { id: "sess_pin/1", input: { id: "i", prompt: "x" } },
  );
  const path = env.PATH.split(":");
  assert.equal(path[0], folder);
  assert.ok(!path.includes(managedToolsBin()));
  assert.equal(
    execFileSync("sh", ["-c", "pin-a"], { env, encoding: "utf8" }),
    "a1\n",
  );
  const other = sessionEnvironment(
    "/w",
    { id: "p", runtime: "codex", connectionType: "local_login" },
    { id: "sess_unpinned", input: { id: "i", prompt: "x" } },
  );
  assert.equal(other.PATH.split(":")[0], managedToolsBin());

  // Live folders survive a reap; released ones are gone.
  reapSessionTools(() => {});
  assert.ok(existsSync(folder));
  tools.release();
  assert.equal(existsSync(folder), false);
  assert.equal(sessionToolsFolder("sess_pin/1"), undefined);
  removeToolVersion("pin-b", "1.0.0");

  // A crashed run's folder is reaped at start.
  const left = join(dirname(folder), "sess_crashed");
  mkdirSync(left, { recursive: true });
  reapSessionTools(() => {});
  assert.equal(existsSync(left), false);

  // Without pins (an older server) a session keeps the shared bin.
  prepareSessionTools("sess_old", undefined).release();
  assert.equal(sessionToolsFolder("sess_old"), undefined);
});
