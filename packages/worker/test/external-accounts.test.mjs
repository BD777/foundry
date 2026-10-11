import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeSessionAccounts,
  reapExternalAccountProfiles,
  sessionExternalAccountEnvironment,
  sessionExternalAccountNote,
} from "../dist/external-accounts.js";
import { sessionEnvironment } from "../dist/session-ambient.js";
import { redactTranscriptText } from "../dist/secret-redaction.js";

const accessToken =
  "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjF9.fake-access-signature-0001";
const clientSecret = "app-secret-value-0123456789abcdef";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "fdy-xacc-"));
  return {
    home: join(root, "home"),
    manifestPath: join(root, "state", "external-account-profiles.json"),
  };
}

function material(overrides = {}) {
  return {
    accountId: "xacc_one",
    provider: "feishu",
    label: "Work Feishu",
    tool: "feishu-cli",
    profileName: "foundry-one",
    clientId: "cli_app",
    clientSecret,
    baseUrl: "http://127.0.0.1:9",
    accessToken,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    scope: "docx:document offline_access",
    subject: "ou_1",
    displayName: "Ada",
    ...overrides,
  };
}

const chat = (id) => ({
  id,
  workspaceId: "ws_1",
  provider: "claude",
  source: "chat",
});

test("an account becomes a private feishu-cli profile selected for the session, and goes with it", () => {
  const paths = scratch();
  const logs = [];
  const held = materializeSessionAccounts(chat("sess_a"), [material()], {
    ...paths,
    log: (line) => logs.push(line),
  });
  const directory = join(paths.home, ".feishu-cli", "profiles", "foundry-one");
  assert.deepEqual(held.profiles, ["foundry-one"]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of ["config.yaml", "token.json"])
    assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);

  const token = JSON.parse(readFileSync(join(directory, "token.json"), "utf8"));
  assert.equal(token.access_token, accessToken);
  assert.equal(token.app_id, "cli_app");
  assert.equal(token.token_type, "Bearer");
  assert.equal("refresh_token" in token, false);
  const config = readFileSync(join(directory, "config.yaml"), "utf8");
  assert.match(config, /^app_id: "cli_app"$/m);
  assert.match(config, new RegExp(`^app_secret: "${clientSecret}"$`, "m"));
  assert.match(config, /^base_url: "http:\/\/127\.0\.0\.1:9"$/m);
  // The person's own pointer is never touched.
  assert.equal(
    existsSync(join(paths.home, ".feishu-cli", "active-profile")),
    false,
  );

  assert.deepEqual(sessionExternalAccountEnvironment("sess_a"), {
    FEISHU_PROFILE: "foundry-one",
  });
  const env = sessionEnvironment(
    "/w",
    { id: "p", runtime: "claude" },
    chat("sess_a"),
  );
  assert.equal(env.FEISHU_PROFILE, "foundry-one");
  assert.equal(env.FEISHU_USER_ACCESS_TOKEN, undefined);
  assert.equal(env.FEISHU_APP_SECRET, undefined);
  const note = sessionExternalAccountNote("sess_a");
  assert.match(note, /Work Feishu \(Ada\): feishu-cli profile foundry-one/);
  assert.match(note, /do not run feishu-cli auth login/);
  assert.equal(
    note.includes(accessToken) || note.includes(clientSecret),
    false,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [directory],
  );
  // What an agent prints of either value never reaches a transcript.
  assert.equal(
    redactTranscriptText(
      `cat token.json → ${accessToken} / ${clientSecret}`,
    ).includes(accessToken),
    false,
  );
  assert.equal(
    redactTranscriptText(`secret ${clientSecret}`).includes(clientSecret),
    false,
  );

  held.release();
  held.release();
  assert.equal(existsSync(directory), false);
  assert.deepEqual(sessionExternalAccountEnvironment("sess_a"), {});
  assert.equal(sessionExternalAccountNote("sess_a"), "");
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [],
  );
  assert.equal(
    logs.some(
      (line) => line.includes(accessToken) || line.includes(clientSecret),
    ),
    false,
  );
});

test("two sessions on one account share the profile until the last one ends", () => {
  const paths = scratch();
  const first = materializeSessionAccounts(
    chat("sess_b1"),
    [material({ profileName: "foundry-two", accountId: "xacc_two" })],
    paths,
  );
  const second = materializeSessionAccounts(
    chat("sess_b2"),
    [material({ profileName: "foundry-two", accountId: "xacc_two" })],
    paths,
  );
  const directory = join(paths.home, ".feishu-cli", "profiles", "foundry-two");
  first.release();
  assert.equal(existsSync(join(directory, "token.json")), true);
  assert.deepEqual(sessionExternalAccountEnvironment("sess_b2"), {
    FEISHU_PROFILE: "foundry-two",
  });
  second.release();
  assert.equal(existsSync(directory), false);
});

test("sessions outside the person's HOME, other tools and bad names get nothing", () => {
  const paths = scratch();
  for (const session of [
    { ...chat("sess_issue"), issueId: "iss_1" },
    { ...chat("sess_name"), source: "naming" },
    { ...chat("sess_verify"), source: "verification" },
    { ...chat("sess_clar"), role: "issue_clarification" },
  ]) {
    const held = materializeSessionAccounts(session, [material()], paths);
    assert.deepEqual(held.profiles, [], session.id);
    assert.deepEqual(sessionExternalAccountEnvironment(session.id), {});
  }
  for (const odd of [
    material({ tool: "gh" }),
    material({ profileName: "default" }),
    material({ profileName: "foundry-../../escape" }),
    material({ accessToken: "" }),
  ])
    assert.deepEqual(
      materializeSessionAccounts(chat("sess_odd"), [odd], paths).profiles,
      [],
    );
  assert.equal(existsSync(join(paths.home, ".feishu-cli")), false);
});

test("a long session gets its token renewed from the server before it expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const paths = scratch();
  const logs = [];
  const renewed = "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjJ9.fake-renewed-signature-02";
  const calls = [];
  let now = Date.parse("2026-10-12T00:00:00Z");
  const held = materializeSessionAccounts(
    chat("sess_long"),
    [
      material({
        profileName: "foundry-long",
        accountId: "xacc_long",
        expiresAt: "2026-10-12T02:00:00Z",
      }),
    ],
    {
      ...paths,
      now: () => now,
      log: (line) => logs.push(line),
      mint: async (accountId, sessionId) => {
        calls.push([accountId, sessionId]);
        return {
          accountId,
          accessToken: renewed,
          tokenType: "Bearer",
          expiresAt: "2026-10-12T03:45:00Z",
          scope: "docx:document",
        };
      },
    },
  );
  const tokenPath = join(
    paths.home,
    ".feishu-cli",
    "profiles",
    "foundry-long",
    "token.json",
  );
  // Nothing happens before 15 minutes ahead of expiry.
  t.mock.timers.tick(100 * 60_000);
  assert.equal(calls.length, 0);
  now += 105 * 60_000;
  t.mock.timers.tick(5 * 60_000);
  await new Promise((settle) => setImmediate(settle));
  assert.deepEqual(calls, [["xacc_long", "sess_long"]]);
  const token = JSON.parse(readFileSync(tokenPath, "utf8"));
  assert.equal(token.access_token, renewed);
  assert.equal(
    Date.parse(token.expires_at),
    Date.parse("2026-10-12T03:45:00Z"),
  );
  assert.match(token.expires_at, /^2026-10-1\dT\d\d:\d\d:00[+-]\d\d:\d\d$/);
  assert.equal(redactTranscriptText(renewed), "[REDACTED]");
  assert.equal(
    logs.some((line) => line.includes(renewed) || line.includes(accessToken)),
    false,
  );
  held.release();
  assert.equal(existsSync(tokenPath), false);
});

test("a refused renewal stops; the session keeps its token until it lapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const paths = scratch();
  const logs = [];
  let calls = 0;
  const held = materializeSessionAccounts(
    chat("sess_revoked"),
    [
      material({
        profileName: "foundry-revoked",
        accountId: "xacc_revoked",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ],
    {
      ...paths,
      log: (line) => logs.push(line),
      mint: async () => {
        calls += 1;
        throw new Error(
          "/api/external-accounts/xacc_revoked/mint returned 409: account revoked",
        );
      },
    },
  );
  t.mock.timers.tick(5_000);
  await new Promise((settle) => setImmediate(settle));
  t.mock.timers.tick(10 * 60_000);
  await new Promise((settle) => setImmediate(settle));
  assert.equal(calls, 1);
  assert.match(logs.join("\n"), /no longer renews it \(HTTP 409\)/);
  assert.equal(
    existsSync(
      join(
        paths.home,
        ".feishu-cli",
        "profiles",
        "foundry-revoked",
        "token.json",
      ),
    ),
    true,
  );
  held.release();
});

test("a restarted worker removes the profiles its predecessor left, and nothing else", () => {
  const paths = scratch();
  const profiles = join(paths.home, ".feishu-cli", "profiles");
  const leftover = join(profiles, "foundry-left");
  const own = join(profiles, "default");
  const unlisted = join(profiles, "foundry-other-worker");
  for (const directory of [leftover, own, unlisted]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "token.json"), "{}");
  }
  mkdirSync(join(paths.manifestPath, ".."), { recursive: true });
  writeFileSync(
    paths.manifestPath,
    JSON.stringify({ profiles: [leftover, own] }),
  );
  assert.deepEqual(reapExternalAccountProfiles(paths), [leftover]);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(own), true);
  assert.equal(existsSync(unlisted), true);
  assert.deepEqual(
    JSON.parse(readFileSync(paths.manifestPath, "utf8")).profiles,
    [],
  );
});
