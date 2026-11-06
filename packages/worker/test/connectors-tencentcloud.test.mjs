import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTencentIdentity,
  parseTencentOAuthPage,
  parseTencentSignInOptions,
  parseTencentSsoPage,
  tencentCloudAdapter,
  tencentSignInFailure,
} from "../dist/connectors/tencentcloud.js";
import {
  installTccli,
  pipFailure,
} from "../dist/connectors/tencentcloud-install.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import { hideHostTools } from "./fixtures/host-tools.mjs";

hideHostTools(["tccli", "python3"]);

const descriptor = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
).find((x) => x.kind === "tencentcloud");

const arn = "qcs::cam::uin/100012345678:uin/100087654321";
const identity = JSON.stringify({
  Arn: arn,
  AccountId: "100012345678",
  Type: "CAMUser",
  UserId: "not-retained",
  PrincipalId: "100087654321",
  RequestId: "r",
});

test("the catalog declares tccli as a device-held CLI with OAuth, CIC and terminal sign-in", () => {
  assert.equal(descriptor.holding, "device_held");
  assert.equal(descriptor.adapter, "tencentcloud");
  assert.equal(descriptor.tool.command, "tccli");
  assert.equal(descriptor.tool.source, "installer");
  assert.deepEqual(
    descriptor.signIn.methods.map((m) => `${m.id}:${m.kind}`),
    ["oauth:guided", "sso:guided", "terminal:terminal"],
  );
  assert.equal(descriptor.signIn.signOut, false);
  assert.equal(descriptor.isolationEnv.TCCLI_PROFILE, "foundry-no-login");
});

test("Tencent identity keeps only the validated ARN and account", () => {
  assert.deepEqual(
    parseTencentIdentity({ code: 0, stdout: identity, stderr: "" }),
    {
      signedIn: true,
      identity: arn,
      sites: ["100012345678"],
    },
  );
  for (const stdout of [
    "null",
    "{}",
    "secret",
    JSON.stringify({ AccountId: "100012345678", Arn: "arn:aws:iam::1:user/x" }),
    JSON.stringify({ AccountId: "999999", Arn: arn }),
  ])
    assert.throws(
      () => parseTencentIdentity({ code: 0, stdout, stderr: "" }),
      /invalid STS identity/,
    );
  // tccli 3.1.196.1, captured with no credential, a missing profile and a bad key.
  for (const stderr of [
    "secretId is invalid",
    "'_sys_param'",
    "[TencentCloudSDKException] code:AuthFailure.SecretIdNotFound message:SecretId不存在 requestId:x",
    "[TencentCloudSDKException] code:AuthFailure.TokenFailure message:token expired",
  ])
    assert.deepEqual(parseTencentIdentity({ code: 255, stdout: "", stderr }), {
      signedIn: false,
    });
  assert.throws(
    () =>
      parseTencentIdentity({
        code: 255,
        stdout: "",
        stderr:
          "[TencentCloudSDKException] code:ClientNetworkError message:secret-proxy",
      }),
    (error) =>
      /identity check failed/.test(error.message) &&
      !error.message.includes("secret"),
  );
});

test("the page's choices are checked before anything runs", () => {
  assert.deepEqual(
    parseTencentSignInOptions({ method: "oauth", region: "ap-shanghai" }),
    {
      method: "oauth",
      region: "ap-shanghai",
    },
  );
  assert.deepEqual(
    parseTencentSignInOptions({
      method: "sso",
      region: "ap-guangzhou",
      signInUrl: "https://tencentcloudsso.com/z-abc/login",
      accountId: "100012345678",
      roleName: "ReadOnly",
    }).roleName,
    "ReadOnly",
  );
  for (const [options, message] of [
    [{}, /Choose how/],
    [{ method: "oauth", region: "Shanghai" }, /Region/],
    [
      { method: "sso", region: "ap-guangzhou", signInUrl: "http://x" },
      /sign-in URL/,
    ],
    [
      {
        method: "sso",
        region: "ap-guangzhou",
        signInUrl: "https://a.com/login",
        accountId: "x",
      },
      /UIN/,
    ],
    [
      {
        method: "sso",
        region: "ap-guangzhou",
        signInUrl: "https://a.com/login",
        accountId: "100012345678",
        roleName: "a b",
      },
      /permission configuration/,
    ],
  ])
    assert.throws(() => parseTencentSignInOptions(options), message);
});

test("tccli's pages and failures are read from its own output", () => {
  // tccli/plugins/auth/login.py with --browser no, captured.
  const oauth =
    "Go to the following link in your browser, and complete the sign-in prompts:\n\nhttps://cloud.tencent.com/open/authorize?scope=login&app_id=100038427476&redirect_url=https%3A%2F%2Fcli.cloud.tencent.com%2Foauth%3Fbrowser%3Dno&state=AbCdEf1234\nOnce finished, enter the verification code provided in your browser: ";
  assert.equal(
    parseTencentOAuthPage(oauth),
    "https://cloud.tencent.com/open/authorize?scope=login&app_id=100038427476&redirect_url=https%3A%2F%2Fcli.cloud.tencent.com%2Foauth%3Fbrowser%3Dno&state=AbCdEf1234",
  );
  assert.equal(
    parseTencentSsoPage(
      "Go to the following link in your browser, and complete the sign-in prompts:\n\nhttps://tencentcloudsso.com/z/login?loginType=tccli&callback=x&state=s\n",
    ),
    "https://tencentcloudsso.com/z/login?loginType=tccli&callback=x&state=s",
  );
  assert.equal(
    tencentSignInFailure("Specified uin not found, uin=1, all=[2,3]\n"),
    "Specified uin not found, uin=1, all=[2,3]",
  );
  assert.doesNotMatch(
    tencentSignInFailure(
      "Traceback (most recent call last):\n binascii.Error: secret-code",
    ),
    /secret/,
  );
});

/**
 * A fake tccli: --version, configure set, sso configure, auth login
 * (prints the page, takes "good-code-0123456789" on stdin), sso login
 * (prints the page, then succeeds) and sts GetCallerIdentity, which reads
 * the default profile unless TCCLI_PROFILE names another.
 */
function fakeTccli(root, version = "3.1.196.1") {
  const state = join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({ configure: {}, signedIn: false, calls: [] }),
  );
  const script = join(root, "tccli");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
// A status read runs two of these at once: replace the file whole, never half-written.
const save = () => { const tmp = ${JSON.stringify(state)} + "." + process.pid; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, ${JSON.stringify(state)}); };
const args = process.argv.slice(2);
state.calls.push(args.join(" ")); save();
if (args[0] === "--version") { console.log("${version}"); process.exit(0); }
if (args[0] === "configure" && args[1] === "set") { state.configure[args[2]] = args[3]; save(); process.exit(0); }
if (args[0] === "sso" && args[1] === "configure") { state.ssoUrl = args[args.indexOf("--url") + 1]; save(); console.log("configure succeed"); process.exit(0); }
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Go to the following link in your browser, and complete the sign-in prompts:\\n\\nhttps://cloud.tencent.com/open/authorize?scope=login&app_id=1&state=s\\nOnce finished, enter the verification code provided in your browser: ");
  let input = "";
  process.stdin.on("data", (d) => { input += d; if (input.includes("\\n")) {
    if (input.trim() === "good-code-0123456789") { state.signedIn = true; save(); console.log("\\nLogin succeed, credential has been written to /home/x/.tccli/default.credential"); process.exit(0); }
    console.error("Traceback (most recent call last):\\nbinascii.Error: Incorrect padding " + input.trim()); process.exit(1);
  }});
  return;
}
if (args[0] === "sso" && args[1] === "login") {
  if (!state.ssoUrl) { console.log("sso url is not configured yet"); process.exit(0); }
  if (args[args.indexOf("--uin") + 1] !== "100012345678") { console.log("\\nSpecified uin not found, uin=" + args[args.indexOf("--uin") + 1] + ", all=[100012345678]"); process.exit(0); }
  console.log("Go to the following link in your browser, and complete the sign-in prompts:\\n\\n" + state.ssoUrl + "?loginType=tccli&callback=c&state=s");
  setTimeout(() => { state.signedIn = true; save(); console.log("Login succeed, credential has been written to x"); process.exit(0); }, 300);
  return;
}
if (args[0] === "sts") {
  if (process.env.TCCLI_PROFILE && process.env.TCCLI_PROFILE !== "default") { console.log("'_sys_param'"); process.exit(255); }
  if (state.signedIn) { console.log(${JSON.stringify(identity)}); process.exit(0); }
  console.log("secretId is invalid"); process.exit(255);
}
process.exit(2);
`,
  );
  chmodSync(script, 0o755);
  return { read: () => JSON.parse(readFileSync(state, "utf8")) };
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function runtime(root) {
  return new DeviceHeldConnectors({
    adapters: { tencentcloud: tencentCloudAdapter },
    managedBin: () => join(root, "managed"),
    toolDirs: [root],
  });
}

const op = (n) => `operation-${n}-${"x".repeat(20)}`;

test("OAuth sign-in shows Tencent's page, takes the pasted code and signs in the default profile", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-tccli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tccli = fakeTccli(root);
  const connectors = runtime(root);
  const before = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(before.state.status, "signed_out");
  assert.equal(before.state.version, "3.1.196.1");
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(1),
    signInOptions: { method: "oauth", region: "ap-shanghai" },
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.status, "pending");
  assert.equal(begin.signIn.codeEntry, true);
  assert.match(
    begin.signIn.verificationUrl,
    /^https:\/\/cloud\.tencent\.com\/open\/authorize\?/,
  );
  assert.equal(tccli.read().configure.region, "ap-shanghai");
  assert.ok(
    tccli
      .read()
      .calls.includes(
        "auth login --browser no --profile default --language en-US",
      ),
  );
  const rejected = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(1),
    input: "not a code!",
  });
  assert.match(rejected.error, /does not look like the code/);
  const sent = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(1),
    input: " good-code-0123456789 ",
  });
  assert.equal(sent.error, undefined, sent.error);
  const done = await until(async () => {
    const poll = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(1),
    });
    return poll.signIn?.status === "complete" ? poll : undefined;
  }, "the sign-in to complete");
  // The server then reads the device to confirm, as after any sign-in.
  const { state: after } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(after.status, "ready");
  assert.equal(after.identity, arn);
  assert.deepEqual(after.sites, ["100012345678"]);
  // A session that may use it sees the login; one that may not does not.
  assert.equal(after.sessionCheck.usable, true, after.sessionCheck.reason);
  assert.equal(
    after.sessionCheck.isolationHolds,
    true,
    after.sessionCheck.isolationReason,
  );
});

test("a wrong pasted code ends the sign-in with a fixed sentence, not tccli's output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-tccli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fakeTccli(root);
  const connectors = runtime(root);
  await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(2),
    signInOptions: { method: "oauth", region: "ap-guangzhou" },
  });
  await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(2),
    input: "wrong-code-0123456789",
  });
  const failed = await until(async () => {
    const poll = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(2),
    });
    return poll.signIn?.status === "failed" ? poll : undefined;
  }, "the sign-in to fail");
  assert.match(failed.signIn.error, /could not finish the sign-in/);
  assert.doesNotMatch(failed.signIn.error, /wrong-code/);
});

test("CIC sign-in configures the URL, relays the page and names a wrong account", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-tccli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tccli = fakeTccli(root);
  const connectors = runtime(root);
  const options = {
    method: "sso",
    region: "ap-guangzhou",
    signInUrl: "https://tencentcloudsso.com/z-abc/login",
    accountId: "100012345678",
    roleName: "ReadOnly",
  };
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(3),
    signInOptions: options,
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.codeEntry, undefined);
  assert.match(
    begin.signIn.verificationUrl,
    /^https:\/\/tencentcloudsso\.com\/z-abc\/login\?loginType=tccli/,
  );
  assert.equal(tccli.read().ssoUrl, options.signInUrl);
  const done = await until(async () => {
    const poll = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(3),
    });
    return poll.signIn?.status === "complete" ? poll : undefined;
  }, "the CIC sign-in to complete");
  // The server then reads the device to confirm, as after any sign-in.
  const { state: after } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(after.status, "ready");

  const wrong = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(4),
    signInOptions: { ...options, accountId: "100099999999" },
  });
  assert.equal(wrong.signIn.status, "failed");
  assert.match(wrong.signIn.error, /Specified uin not found, uin=100099999999/);
});

test("an older tccli is told to update before a sign-in starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-tccli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tccli = fakeTccli(root, "3.0.1200.1");
  const connectors = runtime(root);
  const sso = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(5),
    signInOptions: {
      method: "sso",
      region: "ap-guangzhou",
      signInUrl: "https://a.example.com/login",
      accountId: "100012345678",
      roleName: "R",
    },
  });
  assert.match(
    sso.error,
    /needs tccli 3\.0\.1341 or newer \(this device has 3\.0\.1200\.1\)/,
  );
  assert.ok(!tccli.read().calls.some((call) => call.startsWith("sso")));
});

test("a session that may not use the login gets an unknown profile and no keys", () => {
  const connectors = runtime(tmpdir());
  const isolated = connectors.sessionSetup([
    {
      kind: "tencentcloud",
      adapter: "tencentcloud",
      command: "tccli",
      label: "Tencent Cloud CLI",
      access: "none",
      isolationEnv: descriptor.isolationEnv,
    },
  ]);
  assert.equal(isolated.environment.TCCLI_PROFILE, "foundry-no-login");
  for (const key of [
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "TENCENTCLOUD_TOKEN",
  ])
    assert.equal(isolated.environment[key], "", key);
});

test("pip failures become a sentence without paths or index addresses", () => {
  assert.match(
    pipFailure("ERROR: No matching distribution found for tccli"),
    /found no tccli/,
  );
  assert.match(
    pipFailure(
      "WARNING: Retrying ... NewConnectionError('https://user:pw@mirror/simple')",
    ),
    /could not reach/,
  );
  assert.doesNotMatch(pipFailure("https://user:pw@mirror/simple"), /pw/);
  assert.match(
    pipFailure(
      "The virtual environment was not created successfully because ensurepip is not available",
    ),
    /python3-venv/,
  );
  assert.match(pipFailure("foundry-step-timeout"), /took too long/);
});

test("tccli installs into its own Python environment and links for sessions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-tccli-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  // A fake python3: `-c` answers a version, `-m venv <dir>` makes <dir>/bin/python,
  // which as `-m pip install` writes <dir>/bin/tccli.
  const python = join(root, "python3");
  const venvPython = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a[0] === "-m" && a[1] === "pip") {
  const bin = path.dirname(process.argv[1]);
  fs.writeFileSync(path.join(bin, "tccli"), "#!${process.execPath}\\nconsole.log('3.1.196.1')\\n", { mode: 0o755 });
  process.exit(0);
}
process.exit(3);
`;
  writeFileSync(
    python,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a[0] === "-c") { console.log("3.11"); process.exit(0); }
if (a[0] === "-m" && a[1] === "venv") {
  fs.mkdirSync(path.join(a[2], "bin"), { recursive: true });
  fs.writeFileSync(path.join(a[2], "bin", "python"), ${JSON.stringify(venvPython)}, { mode: 0o755 });
  process.exit(0);
}
process.exit(3);
`,
    { mode: 0o755 },
  );
  const managed = join(root, "managed");
  const first = await installTccli({
    managedBin: managed,
    home,
    python,
    path: "",
  });
  assert.equal(first.version, "3.1.196.1");
  assert.equal(first.path, join(managed, "tccli"));
  assert.equal(
    readFileSync(join(home, ".local", "bin", "tccli"), "utf8").includes(
      "3.1.196.1",
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await installTccli({ managedBin: managed, home, python, path: "" });
  const envs = (await import("node:fs")).readdirSync(
    join(home, ".local", "share", "tccli"),
  );
  assert.equal(envs.length, 1, "the earlier environment is removed");

  const old = join(root, "old-python3");
  writeFileSync(old, `#!${process.execPath}\nconsole.log("3.6")\n`, {
    mode: 0o755,
  });
  await assert.rejects(
    installTccli({ managedBin: managed, home, python: old, path: "" }),
    /Python 3\.7 or newer; this device has 3\.6/,
  );
});
