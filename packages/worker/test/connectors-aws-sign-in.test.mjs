import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAwsSignInOptions,
  parseConsoleSignIn,
  parseDeviceCodeSignIn,
  signInFailure,
} from "../dist/connectors/aws-sign-in.js";
import { awsAdapter } from "../dist/connectors/aws.js";
import { DeviceHeldConnectors } from "../dist/connectors/device-held.js";
import { hideHostTools } from "./fixtures/host-tools.mjs";

hideHostTools(["aws"]);

const descriptor = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/server/internal/connectors/catalog.json",
      import.meta.url,
    ),
  ),
).find((x) => x.kind === "aws");

test("the page's choices are checked before anything runs", () => {
  assert.deepEqual(
    parseAwsSignInOptions({ method: "console", region: "eu-west-1" }),
    {
      method: "console",
      region: "eu-west-1",
    },
  );
  assert.deepEqual(
    parseAwsSignInOptions({
      method: "sso",
      region: "us-east-1",
      startUrl: "https://my-company.awsapps.com/start",
      accountId: "1234-5678-9012",
      roleName: "ReadOnly",
    }),
    {
      method: "sso",
      region: "us-east-1",
      startUrl: "https://my-company.awsapps.com/start",
      ssoRegion: "us-east-1",
      accountId: "123456789012",
      roleName: "ReadOnly",
    },
  );
  for (const [options, message] of [
    [{}, /Choose how/],
    [{ method: "console", region: "nowhere" }, /AWS Region/],
    [{ method: "sso", region: "us-east-1", startUrl: "http://x" }, /start URL/],
    [
      {
        method: "sso",
        region: "us-east-1",
        startUrl: "https://a.awsapps.com/start",
        accountId: "12",
      },
      /12-digit/,
    ],
    [
      {
        method: "sso",
        region: "us-east-1",
        startUrl: "https://a.awsapps.com/start",
        accountId: "123456789012",
        roleName: "a b",
      },
      /role/,
    ],
    [
      {
        method: "sso",
        region: "us-east-1",
        startUrl: "https://a.awsapps.com/start; rm -rf",
        accountId: "123456789012",
        roleName: "R",
      },
      /start URL/,
    ],
  ])
    assert.throws(() => parseAwsSignInOptions(options), message);
});

test("the CLI's sign-in prompts are read as AWS prints them", () => {
  // aws login --remote (AWS CLI 2.39)
  assert.equal(
    parseConsoleSignIn(
      "Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://us-east-1.signin.aws.amazon.com/v1/authorize?response_type=code&client_id=x&state=y\n\nEnter the authorization code displayed in your browser: ",
    ),
    "https://us-east-1.signin.aws.amazon.com/v1/authorize?response_type=code&client_id=x&state=y",
  );
  // aws sso login --use-device-code --no-browser (awscli/customizations/sso/utils.py)
  assert.deepEqual(
    parseDeviceCodeSignIn(
      "Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nABCD-EFGH\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH\n",
    ),
    {
      url: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
      code: "ABCD-EFGH",
    },
  );
  assert.equal(
    parseDeviceCodeSignIn("Please visit the following URL:\n"),
    undefined,
  );
  assert.equal(
    signInFailure(
      "\naws: [ERROR]: An error occurred (AccessDeniedException) when calling the CreateToken operation: denied\n",
    ),
    "An error occurred (AccessDeniedException) when calling the CreateToken operation: denied",
  );
});

/**
 * A fake aws on the device: --version, configure get/set (into a file),
 * login --remote (prints the sign-in URL, waits for the code on stdin,
 * succeeds for "good-code"), sso login (prints a device code, then succeeds)
 * and sts get-caller-identity (signed in once a login succeeded).
 */
function fakeAws(root, version = "2.39.1") {
  const state = join(root, "state.json");
  writeFileSync(state, JSON.stringify({ config: {}, signedIn: false }));
  const script = join(root, "aws");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("aws-cli/${version} Python/3.14"); process.exit(0); }
const profile = args[args.indexOf("--profile") + 1] || "default";
if (args[0] === "configure" && args[1] === "get") { console.log((state.config[profile] ?? {})[args[2]] ?? ""); process.exit(0); }
if (args[0] === "configure" && args[1] === "set") { (state.config[profile] ??= {})[args[2]] = args[3]; save(); process.exit(0); }
if (args[0] === "login") {
  process.stdout.write("Browser will not be automatically opened.\\nPlease visit the following URL:\\n\\nhttps://us-east-1.signin.aws.amazon.com/v1/authorize?response_type=code&state=s\\n\\nEnter the authorization code displayed in your browser: ");
  let input = "";
  process.stdin.on("data", (d) => { input += d; if (input.includes("\\n")) {
    if (input.trim() === "good-code") { state.signedIn = true; save(); console.log("Updated profile default"); process.exit(0); }
    console.error("aws: [ERROR]: An error occurred (InvalidGrant): the authorization code is invalid"); process.exit(255);
  }});
  return;
}
if (args[0] === "sso" && args[1] === "login") {
  console.log("Browser will not be automatically opened.\\nPlease visit the following URL:\\n\\nhttps://device.sso.us-east-1.amazonaws.com/\\n\\nThen enter the code:\\n\\nWXYZ-1234\\n\\nAlternatively, you may visit the following URL which will autofill the code upon loading:\\nhttps://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234");
  setTimeout(() => { state.signedIn = true; save(); console.log("Successfully logged into Start URL"); process.exit(0); }, 300);
  return;
}
if (args[0] === "sts") {
  if (state.signedIn) { console.log(JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/me", UserId: "x" })); process.exit(0); }
  console.error("Unable to locate credentials"); process.exit(255);
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
    adapters: { aws: awsAdapter },
    managedBin: () => join(root, "managed"),
    toolDirs: [root],
  });
}

const op = (n) => `operation-${n}-${"x".repeat(20)}`;

test("console sign-in: the device shows the AWS page, takes the pasted code and signs in", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-signin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aws = fakeAws(root);
  const connectors = runtime(root);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(1),
    signInOptions: { method: "console", region: "eu-west-1" },
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.status, "pending");
  assert.equal(begin.signIn.codeEntry, true);
  assert.match(
    begin.signIn.verificationUrl,
    /^https:\/\/us-east-1\.signin\.aws\.amazon\.com\//,
  );
  // The default profile got a Region, as sessions need one.
  assert.equal(aws.read().config.default.region, "eu-west-1");

  const pending = await connectors.handle({
    action: "sign_in_poll",
    connector: descriptor,
    operationId: op(1),
  });
  assert.equal(pending.signIn.status, "pending");
  assert.equal(
    pending.signIn.codeEntry,
    true,
    "a poll keeps what the page needs",
  );

  const typed = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(1),
    input: "good-code",
  });
  assert.equal(typed.error, undefined, typed.error);
  const done = await until(async () => {
    const next = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(1),
    });
    return next.signIn.status !== "pending" && next;
  }, "the sign-in to end");
  assert.equal(done.signIn.status, "complete");
  // The server then reads the device to confirm (as it does after any sign-in).
  const { state } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(state.status, "ready");
  assert.equal(state.identity, "arn:aws:iam::123456789012:user/me");
});

test("console sign-in: a wrong code is the CLI's reason; dismissal ends the waiting CLI", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-signin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fakeAws(root);
  const connectors = runtime(root);
  await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(2),
    signInOptions: { method: "console", region: "us-east-1" },
  });
  await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(2),
    input: "wrong-code",
  });
  const failed = await until(async () => {
    const next = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(2),
    });
    return next.signIn.status !== "pending" && next;
  }, "the failure");
  assert.equal(failed.signIn.status, "failed");
  assert.match(failed.signIn.error, /authorization code is invalid/);

  // A new sign-in, dismissed: typing into it afterwards is refused.
  await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(3),
    signInOptions: { method: "console", region: "us-east-1" },
  });
  await connectors.handle({
    action: "sign_in_dismiss",
    connector: descriptor,
    operationId: op(3),
  });
  const late = await connectors.handle({
    action: "sign_in_input",
    connector: descriptor,
    operationId: op(3),
    input: "good-code",
  });
  assert.equal(late.signIn?.status, "expired");
});

test("IAM Identity Center: settings from the page, then a device code the person enters anywhere", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-signin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aws = fakeAws(root);
  const connectors = runtime(root);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(4),
    signInOptions: {
      method: "sso",
      region: "eu-central-1",
      startUrl: "https://my-company.awsapps.com/start",
      ssoRegion: "us-east-1",
      accountId: "123456789012",
      roleName: "Developer",
    },
  });
  assert.equal(begin.error, undefined, begin.error);
  assert.equal(begin.signIn.userCode, "WXYZ-1234");
  assert.equal(
    begin.signIn.verificationUrl,
    "https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234",
  );
  assert.equal(begin.signIn.codeEntry, undefined);
  const settings = {
    sso_start_url: "https://my-company.awsapps.com/start",
    sso_region: "us-east-1",
    sso_account_id: "123456789012",
    sso_role_name: "Developer",
    region: "eu-central-1",
  };
  // Until it succeeded only the staging profile has them: the default
  // profile (sessions') is untouched by a sign-in that fails.
  assert.deepEqual(aws.read().config, { "foundry-sign-in": settings });
  const done = await until(async () => {
    const next = await connectors.handle({
      action: "sign_in_poll",
      connector: descriptor,
      operationId: op(4),
    });
    return next.signIn.status !== "pending" && next;
  }, "the device-code sign-in");
  assert.equal(done.signIn.status, "complete");
  const { state } = await connectors.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(state.signedIn, true);
  assert.deepEqual(aws.read().config.default, settings);
});

test("an AWS CLI too old for browser sign-in says to update first", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-signin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fakeAws(root, "2.27.0");
  const connectors = runtime(root);
  const begin = await connectors.handle({
    action: "sign_in_begin",
    connector: descriptor,
    operationId: op(5),
    signInOptions: { method: "console", region: "us-east-1" },
  });
  assert.match(
    begin.error ?? begin.signIn?.error ?? "",
    /needs AWS CLI 2\.32\.0 or newer \(this device has 2\.27\.0\)/,
  );
});
