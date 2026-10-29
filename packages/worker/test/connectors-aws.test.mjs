import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsAdapter, parseAWSIdentity } from "../dist/connectors/aws.js";
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
const arn = "arn:aws:sts::123456789012:assumed-role/Developer/session";
const ok = {
  code: 0,
  stdout: JSON.stringify({
    Account: "123456789012",
    Arn: arn,
    UserId: "not-retained",
  }),
  stderr: "",
};

test("AWS retains only validated identity metadata and handles other partitions", () => {
  assert.deepEqual(parseAWSIdentity(ok), {
    signedIn: true,
    identity: arn,
    sites: ["123456789012"],
  });
  assert.equal(
    parseAWSIdentity({
      ...ok,
      stdout: ok.stdout.replace("arn:aws:", "arn:aws-cn:"),
    }).signedIn,
    true,
  );
  for (const stdout of [
    "null",
    "{}",
    "[]",
    "secret",
    JSON.stringify({ Account: "000000000000", Arn: arn }),
  ])
    assert.throws(
      () => parseAWSIdentity({ ...ok, stdout }),
      /invalid STS identity/,
    );
});

test("AWS distinguishes missing or expired credentials from failed verification without exposing stderr", () => {
  for (const stderr of [
    "Unable to locate credentials",
    "ExpiredToken: secret",
    "Error loading SSO Token",
    "The config profile (missing) could not be found",
  ])
    assert.deepEqual(parseAWSIdentity({ code: 1, stdout: "", stderr }), {
      signedIn: false,
    });
  for (const stderr of [
    "Could not connect to the endpoint URL: secret",
    "credential_process failed: secret",
    "AccessDenied: secret",
  ])
    assert.throws(
      () => parseAWSIdentity({ code: 1, stdout: "", stderr }),
      (error) =>
        /identity check failed/.test(error.message) &&
        !error.message.includes("secret"),
    );
});

test("AWS reads version from either stream, bounds STS and refuses native auth mutations", async () => {
  assert.equal(
    await awsAdapter.readVersion(async () => ({
      code: 0,
      stdout: "",
      stderr: "aws-cli/1.40.0 Python/3.12",
    })),
    "1.40.0",
  );
  await assert.rejects(
    awsAdapter.readVersion(async () => ({
      code: 1,
      stdout: "secret",
      stderr: "",
    })),
    /version/,
  );
  const reading = await awsAdapter.readLogin(async (args, options) => {
    assert.deepEqual(args, [
      "sts",
      "get-caller-identity",
      "--output",
      "json",
      "--cli-connect-timeout",
      "5",
      "--cli-read-timeout",
      "5",
    ]);
    assert.equal(options.timeoutMs, 20_000);
    return ok;
  });
  assert.equal(reading.signedIn, true);
  for (const action of ["beginSignIn", "pollSignIn", "signOut"])
    await assert.rejects(
      awsAdapter[action](() => {
        throw new Error("must not execute");
      }),
      /device terminal/,
    );
});

test("AWS device dispatch checks a subprocess, caches state, installs only through its adapter and isolates absent tools", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fake = join(bin, "aws");
  writeFileSync(
    fake,
    `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('aws-cli/2.38.2 Python/3.13'); else if (process.env.AWS_CLI_AUTO_PROMPT !== 'off' || process.env.AWS_PAGER !== '') process.exit(1); else console.log(${JSON.stringify(ok.stdout)});\n`,
    { mode: 0o755 },
  );
  const installs = [];
  const runtime = new DeviceHeldConnectors({
    // The real installer downloads from AWS; connectors-aws-install covers it.
    adapters: {
      aws: {
        ...awsAdapter,
        install: async (managed) => {
          installs.push(managed);
          throw new Error("installer stubbed");
        },
      },
    },
    managedBin: () => join(root, "managed"),
    toolDirs: [bin],
  });
  const { state } = await runtime.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(state.status, "ready");
  assert.equal(state.installSource, "device");
  assert.equal(state.version, "2.38.2");
  assert.equal(state.identity, arn);
  assert.match(
    (await runtime.handle({ action: "install", connector: descriptor })).error,
    /installer stubbed/,
  );
  assert.deepEqual(installs, [join(root, "managed")]);
  const use = {
    kind: "aws",
    adapter: "aws",
    command: "aws",
    label: "AWS CLI",
    access: "device_login",
  };
  assert.deepEqual(runtime.sessionSetup([use]).environment, {});
  assert.match(
    runtime.sessionSetup([use]).notes.join("\n"),
    /sts get-caller-identity/,
  );
  const isolated = runtime.sessionSetup([
    { ...use, access: "none", isolationEnv: descriptor.isolationEnv },
  ]);
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  ])
    assert.equal(isolated.environment[key], "", key);
  assert.equal(isolated.environment.AWS_CONFIG_FILE, "/dev/null");
  assert.equal(isolated.environment.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
  assert.equal(isolated.environment.AWS_EC2_METADATA_DISABLED, "true");
  assert.equal(isolated.environment.AWS_DEFAULT_PROFILE, "foundry-no-login");
  rmSync(fake);
  assert.deepEqual(
    runtime.sessionSetup([{ ...use, access: "none" }]).environment,
    isolated.environment,
  );
});

test("an AWS CLI on PATH is preferred to Foundry's tool folders", async (t) => {
  // The device's own install wins, as on the CI image that ships aws.
  const root = mkdtempSync(join(tmpdir(), "fdy-aws-host-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const tool = (folder, body) => {
    mkdirSync(join(root, folder));
    writeFileSync(
      join(root, folder, "aws"),
      `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('aws-cli/2.38.2 Python/3.13'); else ${body}\n`,
      { mode: 0o755 },
    );
    return join(root, folder);
  };
  const host = tool(
    "host",
    "{ console.error('Unable to locate credentials'); process.exit(255); }",
  );
  const extra = tool("extra", `console.log(${JSON.stringify(ok.stdout)});`);
  const previous = process.env.PATH;
  process.env.PATH = host;
  t.after(() => {
    process.env.PATH = previous;
  });
  const runtime = new DeviceHeldConnectors({
    adapters: { aws: awsAdapter },
    managedBin: () => join(root, "managed"),
    toolDirs: [extra],
  });
  const { state } = await runtime.handle({
    action: "status",
    connector: descriptor,
    fresh: true,
  });
  assert.equal(state.status, "signed_out");
  assert.equal(state.installSource, "device");
});
