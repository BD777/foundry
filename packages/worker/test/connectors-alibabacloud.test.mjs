import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alibabaCloudAdapter,
  aliyunSignInFailure,
  checkedCallback,
  parseAliyunDeviceCode,
  parseAliyunIdentity,
  parseAliyunOAuthPage,
  parseAliyunSignInOptions,
} from "../dist/connectors/alibabacloud.js";
import {
  aliyunArchiveName,
  aliyunVersionFromLocation,
  installAliyunCli,
} from "../dist/connectors/alibabacloud-install.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import { hideHostTools } from "./fixtures/host-tools.mjs";

hideHostTools(["aliyun"]);

const descriptor = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
).find((x) => x.kind === "alibabacloud");

const arn = "acs:ram::1234567890123456:user/dev";
const identity = JSON.stringify({
  AccountId: "1234567890123456",
  Arn: arn,
  IdentityType: "RAMUser",
  PrincipalId: "not-retained",
  UserId: "not-retained",
  RequestId: "r",
});
// aliyun 3.5.3 with no configuration (stderr when not a terminal), captured.
const notConfigured =
  '{"schemaVersion":"v1","message":"profile configuration failed","recovery":{"action":"check_configuration","command":"aliyun configure","hint":"Check that the selected profile exists"}}';

test("the catalog declares aliyun as a device-held CLI with OAuth, CloudSSO and terminal sign-in", () => {
  assert.equal(descriptor.holding, "device_held");
  assert.equal(descriptor.adapter, "alibabacloud");
  assert.equal(descriptor.tool.command, "aliyun");
  assert.equal(descriptor.tool.minimumVersion, "3.5.2");
  assert.deepEqual(
    descriptor.signIn.methods.map((m) => `${m.id}:${m.kind}`),
    ["oauth:guided", "sso:guided", "terminal:terminal"],
  );
  assert.equal(descriptor.isolationEnv.ALIBABA_CLOUD_IGNORE_PROFILE, "TRUE");
});

test("Alibaba identity keeps only the validated ARN and account", () => {
  assert.deepEqual(
    parseAliyunIdentity({ code: 0, stdout: identity, stderr: "" }),
    {
      signedIn: true,
      identity: arn,
      sites: ["1234567890123456"],
    },
  );
  assert.equal(
    parseAliyunIdentity({
      code: 0,
      stdout: JSON.stringify({
        AccountId: "1234567890123456",
        Arn: "acs:ram::1234567890123456:assumed-role/aliyunreservedsso-admin/dev",
      }),
      stderr: "",
    }).signedIn,
    true,
  );
  for (const stdout of [
    "{}",
    "secret",
    JSON.stringify({
      AccountId: "1234567890123456",
      Arn: "acs:ram::999999:user/x",
    }),
  ])
    assert.throws(
      () => parseAliyunIdentity({ code: 0, stdout, stderr: "" }),
      /invalid STS identity/,
    );
  for (const stderr of [
    notConfigured,
    '{"schemaVersion":"v1","message":"Specified access key is not found.","error_code":"InvalidAccessKeyId.NotFound","status_code":404}',
    '{"schemaVersion":"v1","message":"SSO session \\"foundry\\" is not logged in or has expired; run `aliyun configure sso login --sso-session foundry`"}',
  ])
    assert.deepEqual(parseAliyunIdentity({ code: 3, stdout: "", stderr }), {
      signedIn: false,
    });
  assert.throws(
    () =>
      parseAliyunIdentity({
        code: 2,
        stdout: "",
        stderr:
          '{"schemaVersion":"v1","message":"dial tcp secret-host: i/o timeout","recovery":{"action":"retry_or_fix_endpoint"}}',
      }),
    (error) =>
      /identity check failed/.test(error.message) &&
      !error.message.includes("secret"),
  );
});

test("the page's choices and the pasted address are checked before anything runs", () => {
  assert.deepEqual(
    parseAliyunSignInOptions({ method: "oauth", region: "cn-shanghai" }),
    {
      method: "oauth",
      region: "cn-shanghai",
      site: "CN",
    },
  );
  assert.equal(
    parseAliyunSignInOptions({
      method: "oauth",
      region: "ap-southeast-1",
      site: "INTL",
    }).site,
    "INTL",
  );
  for (const [options, message] of [
    [{}, /Choose how/],
    [{ method: "oauth", region: "hangzhou" }, /Region/],
    [{ method: "oauth", region: "cn-hangzhou", site: "JP" }, /site/],
    [
      { method: "sso", region: "cn-hangzhou", signInUrl: "ftp://x" },
      /sign-in URL/,
    ],
    [
      {
        method: "sso",
        region: "cn-hangzhou",
        signInUrl: "https://signin-cn-shanghai.alibabacloudsso.com/d/login",
        accountId: "1234567890123456",
        accessConfig: "admin",
      },
      /starts with ac-/,
    ],
  ])
    assert.throws(() => parseAliyunSignInOptions(options), message);
  assert.equal(
    checkedCallback(" http://127.0.0.1:12345/cli/callback?code=abc&state=s1 "),
    "http://127.0.0.1:12345/cli/callback?code=abc&state=s1",
  );
  for (const input of [
    "abc",
    "http://127.0.0.1:12345/cli/callback?code=abc",
    "https://evil.example/cli/callback?code=a&state=s",
    "http://127.0.0.1:12345/cli/callback?state=s",
  ])
    assert.throws(() => checkedCallback(input), /whole address/);
});

test("aliyun's pages and failures are read from its own output", () => {
  // config/oauth_manual.go and cloudsso/login.go wording.
  assert.equal(
    parseAliyunOAuthPage(
      "Open this link in a browser on your computer or phone:\nhttps://signin.aliyun.com/oauth2/v1/auth?client_id=4038181954557748008&code_challenge=x&state=s\n\nSign in.",
    ),
    "https://signin.aliyun.com/oauth2/v1/auth?client_id=4038181954557748008&code_challenge=x&state=s",
  );
  assert.deepEqual(
    parseAliyunDeviceCode(
      "If the browser does not open automatically, use the following URL to complete the login process:\n\nSignIn url: https://signin-cn-shanghai.alibabacloudsso.com/device/code\nUser code: ABCD-EFGH\n",
    ),
    {
      url: "https://signin-cn-shanghai.alibabacloudsso.com/device/code",
      code: "ABCD-EFGH",
    },
  );
  assert.match(
    aliyunSignInFailure("You are not allowed to do this action."),
    /official-cli/,
  );
  assert.equal(
    aliyunSignInFailure("panic: secret"),
    "aliyun ended without signing in.",
  );
});

/**
 * A fake aliyun: version, configure --mode OAuth --no-browser (site prompt,
 * page, callback line, Region and language prompts), configure sso login
 * (device code, then success), configure set (recorded) and sts
 * GetCallerIdentity, which ALIBABA_CLOUD_IGNORE_PROFILE=TRUE keeps from the
 * profile as aliyun does.
 */
function fakeAliyun(root, version = "3.5.3", { refuse = false } = {}) {
  const state = join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({ signedIn: false, answers: [], sets: [] }),
  );
  const script = join(root, "aliyun");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("${version}"); process.exit(0); }
if (args[0] === "configure" && args[1] === "set") { state.sets.push(args.slice(2).join(" ")); save(); process.exit(0); }
if (args[0] === "configure" && args[1] === "sso" && args[2] === "login") {
  console.log("If the browser does not open automatically, use the following URL to complete the login process:\\n\\nSignIn url: https://signin-cn-shanghai.alibabacloudsso.com/device/code\\nUser code: WXYZ-1234\\n");
  setTimeout(() => { state.sso = true; save(); console.log("You have successfully logged in."); process.exit(0); }, 300);
  return;
}
if (args[0] === "configure" && args.includes("OAuth")) {
  console.log("Configuring profile 'default' in 'OAuth' authenticate mode...");
  console.log("OAuth Site Type (CN: 0 or INTL: 1, default: CN): ");
  const prompts = ["site", "callback", "region", "language"];
  let buffer = "";
  process.stdin.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const step = prompts[state.answers.length];
      state.answers.push(line); save();
      if (step === "site") process.stdout.write("Open this link in a browser on your computer or phone:\\n" + (line === "1" ? "https://signin.alibabacloud.com" : "https://signin.aliyun.com") + "/oauth2/v1/auth?client_id=1&state=s1\\n\\nCallback URL (Ctrl+C to cancel): ");
      if (step === "callback") {
        if (!line.includes("state=s1")) { state.answers.pop(); save(); process.stdout.write("invalid state. Please paste the complete callback URL for this login.\\nCallback URL (Ctrl+C to cancel): "); continue; }
        if (${refuse}) { console.error("You are not allowed to do this action."); process.exit(1); }
        process.stdout.write("OAuth configuration completed.\\n\\nDefault Region Id []: ");
      }
      if (step === "region") process.stdout.write("Default Output Format [json]: json (Only support json)\\nDefault Language [zh|en] : ");
      if (step === "language") { state.signedIn = true; save(); console.log("Saving profile[default] ...Done."); process.exit(0); }
    }
  });
  return;
}
if (args[0] === "sts") {
  if (process.env.ALIBABA_CLOUD_IGNORE_PROFILE === "TRUE" || !(state.signedIn || state.sets.length)) { console.error(${JSON.stringify(notConfigured)}); process.exit(3); }
  console.log(${JSON.stringify(identity)}); process.exit(0);
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
    adapters: { alibabacloud: alibabaCloudAdapter },
    managedBin: () => join(root, "managed"),
    toolDirs: [root],
  });
}

const op = (n) => `operation-${n}-${"x".repeat(20)}`;
const poll = (connectors, id) =>
  connectors.handle({
    action: "sign_in_poll",
    connector: descriptor,
    operationId: id,
  });

test("OAuth sign-in answers aliyun's prompts and takes the pasted callback address", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aliyun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aliyun = fakeAliyun(root);
  const connectors = runtime(root);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(1),
    signInOptions: { method: "oauth", region: "cn-shanghai", site: "CN" },
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.status, "pending");
  assert.equal(begin.signIn.codeEntry, true);
  assert.equal(begin.signIn.codeEntryFormat, "callback_url");
  assert.match(
    begin.signIn.verificationUrl,
    /^https:\/\/signin\.aliyun\.com\/oauth2\/v1\/auth\?/,
  );
  assert.deepEqual(aliyun.read().answers, ["0"]);
  const bad = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(1),
    input: "the-code-only",
  });
  assert.match(bad.error, /whole address/);
  const sent = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(1),
    input: "http://127.0.0.1:12345/cli/callback?code=c0de&state=s1",
  });
  assert.equal(sent.error, undefined, sent.error);
  const done = await until(async () => {
    const answer = await poll(connectors, op(1));
    return answer.signIn?.status === "complete" ? answer : undefined;
  }, "the OAuth sign-in to complete");
  // The server then reads the device to confirm, as after any sign-in.
  const { state: after } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.deepEqual(aliyun.read().answers, [
    "0",
    "http://127.0.0.1:12345/cli/callback?code=c0de&state=s1",
    "cn-shanghai",
    "",
  ]);
  assert.equal(after.status, "ready");
  assert.equal(after.identity, arn);
  assert.equal(after.sessionCheck.usable, true, after.sessionCheck.reason);
  assert.equal(
    after.sessionCheck.isolationHolds,
    true,
    after.sessionCheck.isolationReason,
  );
});

test("an address from another sign-in, and a RAM refusal, end the sign-in with a sentence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aliyun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fakeAliyun(root);
  const connectors = runtime(root);
  await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(2),
    signInOptions: { method: "oauth", region: "cn-hangzhou" },
  });
  await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(2),
    input: "http://127.0.0.1:12345/cli/callback?code=c0de&state=old",
  });
  const stale = await until(async () => {
    const answer = await poll(connectors, op(2));
    return answer.signIn?.status === "failed" ? answer : undefined;
  }, "the stale address to fail");
  assert.match(stale.signIn.error, /not an earlier one/);

  const refusing = mkdtempSync(join(tmpdir(), "fdy-aliyun-"));
  t.after(() => rmSync(refusing, { recursive: true, force: true }));
  fakeAliyun(refusing, "3.5.3", { refuse: true });
  const other = runtime(refusing);
  await other.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(3),
    signInOptions: { method: "oauth", region: "cn-hangzhou" },
  });
  await other.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(3),
    input: "http://127.0.0.1:12345/cli/callback?code=c0de&state=s1",
  });
  const refused = await until(async () => {
    const answer = await poll(other, op(3));
    return answer.signIn?.status === "failed" ? answer : undefined;
  }, "the refusal");
  assert.match(refused.signIn.error, /official-cli OAuth application/);
});

test("CloudSSO sign-in relays the device code, then points the default profile at the account", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aliyun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aliyun = fakeAliyun(root);
  const connectors = runtime(root);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(4),
    signInOptions: {
      method: "sso",
      region: "cn-hangzhou",
      signInUrl: "https://signin-cn-shanghai.alibabacloudsso.com/d-abc/login",
      accountId: "1234567890123456",
      accessConfig: "ac-0123abcd",
    },
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.userCode, "WXYZ-1234");
  assert.equal(
    begin.signIn.verificationUrl,
    "https://signin-cn-shanghai.alibabacloudsso.com/device/code",
  );
  const done = await until(async () => {
    const answer = await poll(connectors, op(4));
    return answer.signIn?.status === "complete" ? answer : undefined;
  }, "the CloudSSO sign-in to complete");
  // The server then reads the device to confirm, as after any sign-in.
  const { state: after } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.deepEqual(aliyun.read().sets, [
    "--profile default --mode CloudSSO --sso-session foundry --cloud-sso-account-id 1234567890123456 --cloud-sso-access-config ac-0123abcd --region cn-hangzhou",
  ]);
  assert.equal(after.status, "ready");
});

test("an aliyun older than 3.5.2 is told to update before a sign-in starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aliyun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fakeAliyun(root, "3.4.0");
  const answer = await runtime(root).handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(5),
    signInOptions: { method: "oauth", region: "cn-hangzhou" },
  });
  assert.match(
    answer.error,
    /needs Alibaba Cloud CLI 3\.5\.2 or newer \(this device has 3\.4\.0\)/,
  );
});

test("a session that may not use the login ignores aliyun's profiles and has no keys", () => {
  const isolated = runtime(tmpdir()).sessionSetup([
    {
      kind: "alibabacloud",
      adapter: "alibabacloud",
      command: "aliyun",
      label: "Alibaba Cloud CLI",
      access: "none",
      isolationEnv: descriptor.isolationEnv,
    },
  ]);
  assert.equal(isolated.environment.ALIBABA_CLOUD_IGNORE_PROFILE, "TRUE");
  for (const key of [
    "ALIBABA_CLOUD_ACCESS_KEY_ID",
    "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
    "ALIBABA_CLOUD_SECURITY_TOKEN",
    "ALICLOUD_ACCESS_KEY_ID",
  ])
    assert.equal(isolated.environment[key], "", key);
});

test("release archives are named for the machine and the version comes from the release redirect", () => {
  assert.equal(
    aliyunArchiveName("3.5.3", "linux", "x64"),
    "aliyun-cli-linux-3.5.3-amd64.tgz",
  );
  assert.equal(
    aliyunArchiveName("3.5.3", "darwin", "arm64"),
    "aliyun-cli-macosx-3.5.3-arm64.tgz",
  );
  assert.throws(
    () => aliyunArchiveName("3.5.3", "win32", "x64"),
    /Linux and macOS/,
  );
  assert.throws(
    () => aliyunArchiveName("3.5.3", "linux", "ia32"),
    /no release/,
  );
  assert.equal(
    aliyunVersionFromLocation(
      "https://github.com/aliyun/aliyun-cli/releases/tag/v3.5.3",
    ),
    "3.5.3",
  );
  assert.throws(
    () =>
      aliyunVersionFromLocation(
        "https://github.com/aliyun/aliyun-cli/releases",
      ),
    /without/,
  );
});

test("the installer checks the archive against the release's sum, prefers the CDN and falls back to GitHub", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aliyun-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The installer unpacks with the device's tar; hideHostTools emptied PATH.
  const hidden = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  t.after(() => {
    process.env.PATH = hidden;
  });
  const pack = (body) => {
    const dir = mkdtempSync(join(root, "pack-"));
    writeFileSync(join(dir, "aliyun"), `#!${process.execPath}\n${body}\n`, {
      mode: 0o755,
    });
    const tgz = join(dir, "a.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", dir, "aliyun"]);
    return tgz;
  };
  const good = pack("console.log('3.5.3')");
  const tampered = pack("console.log('3.5.3') // changed");
  const name = aliyunArchiveName("3.5.3", "linux", "x64");
  const sum = createHash("sha256").update(readFileSync(good)).digest("hex");
  const downloads = [];
  const serve = (cdnArchive) => async (url, file) => {
    downloads.push(url);
    if (url.endsWith("/SHASUMS256.txt"))
      writeFileSync(file, `${sum}  ${name}\n`);
    else if (url.startsWith("https://aliyuncli.alicdn.com/")) {
      if (!cdnArchive) throw new Error("unreachable");
      copyFileSync(cdnArchive, file);
    } else copyFileSync(good, file);
  };
  const home = join(root, "home");
  const managed = join(root, "managed");
  const options = {
    managedBin: managed,
    home,
    platform: "linux",
    arch: "x64",
    latestVersion: async () => "3.5.3",
    path: "",
  };
  const first = await installAliyunCli({ ...options, download: serve(good) });
  assert.equal(first.version, "3.5.3");
  assert.deepEqual(downloads, [
    "https://github.com/aliyun/aliyun-cli/releases/download/v3.5.3/SHASUMS256.txt",
    `https://aliyuncli.alicdn.com/${name}`,
  ]);
  assert.ok(existsSync(join(managed, "aliyun")));
  assert.ok(existsSync(join(home, ".local", "bin", "aliyun")));

  downloads.length = 0;
  await installAliyunCli({ ...options, download: serve(tampered) });
  assert.equal(
    downloads.at(-1),
    `https://github.com/aliyun/aliyun-cli/releases/download/v3.5.3/${name}`,
    "a CDN copy that does not match is replaced from GitHub",
  );
  downloads.length = 0;
  await installAliyunCli({ ...options, download: serve(undefined) });
  assert.equal(
    downloads.at(-1),
    `https://github.com/aliyun/aliyun-cli/releases/download/v3.5.3/${name}`,
  );
  assert.deepEqual(readdirSync(join(home, ".local", "share", "aliyun-cli")), [
    "3.5.3",
  ]);

  await assert.rejects(
    installAliyunCli({
      ...options,
      download: async (url, file) => {
        if (url.endsWith("/SHASUMS256.txt"))
          writeFileSync(file, `${sum}  ${name}\n`);
        else copyFileSync(tampered, file);
      },
    }),
    /does not match the release's checksum/,
  );
});

test("a device with no profile yet reads as signed out, from aliyun's plain-text first run", () => {
  // aliyun 3.5.3 on a fresh HOME, before ~/.aliyun exists.
  const stderr =
    "ERROR: region can't be empty\n\nConfiguration failed, use `aliyun configure` to configure it\n";
  assert.deepEqual(parseAliyunIdentity({ code: 3, stdout: "", stderr }), {
    signedIn: false,
  });
});
