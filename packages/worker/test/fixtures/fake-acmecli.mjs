#!/usr/bin/env node
// A synthetic JSON CLI for declarative-extension tests. It answers from
// $FAKE_ACMECLI_DIR/state.json and appends every call to calls.jsonl. The
// shapes exercise envelope parsing, two-step guided sign-in, continuation
// authorization, fallback, minVersion, status rules and error-code copy.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_ACMECLI_DIR;
const statePath = join(dir, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
appendFileSync(
  join(dir, "calls.jsonl"),
  `${JSON.stringify({
    args,
    noAutoUpgrade: process.env.ACME_NO_AUTO_UPGRADE ?? null,
    profile: process.env.ACME_PROFILE ?? null,
  })}\n`,
);
const save = () => writeFileSync(statePath, JSON.stringify(state));
const words = args.filter((arg) => !arg.startsWith("-"));
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jm1kAAAAASUVORK5CYII=",
  "base64",
);
const qrPath = args.includes("--qr-image")
  ? args[args.indexOf("--qr-image") + 1]
  : undefined;
const out = (value, code = 0) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = code;
};
const ok = (data) => out({ ok: true, data, error: null });
const fail = (code, message, hint) =>
  out({ ok: false, data: null, error: { code, message, hint } }, 1);

function main() {
  if (args.includes("--version")) {
    process.stdout.write(`acmecli ${state.version ?? "1.2.3"}\n`);
    return;
  }

  if (words[0] === "status") {
    if (!state.signedIn)
      return ok({
        authenticated: false,
        account: { status: "need_login" },
        profiles: [],
      });
    return ok({
      authenticated: true,
      account: {
        status: state.noAccountStatus ? undefined : "ready",
        name: state.user ?? "alice@example.com",
        region: state.site ?? "eu",
        expires: state.expires ?? "2027-01-02T03:04:05+00:00",
      },
      profiles: [{ name: "one", tools: ["claude"] }],
    });
  }

  if (words[0] === "login" && args.includes("--begin")) {
    if (qrPath) writeFileSync(qrPath, image);
    if (state.noChallenge)
      return ok({ login_status: "pending", complete_token: undefined });
    if (state.challenge === "approved") {
      state.signedIn = true;
      state.challenge = "none";
      save();
      return ok({ login_status: "success" });
    }
    state.challenge = "pending";
    save();
    return ok({
      login_status: "pending",
      verification_uri_complete: "https://acme.example/approve",
    });
  }

  if (words[0] === "login" && args.includes("--poll")) {
    switch (state.challenge) {
      case "pending":
        return ok({ login_status: "pending" });
      case "approved":
        state.signedIn = true;
        state.challenge = "none";
        save();
        return ok({ login_status: "success" });
      case "denied":
        state.challenge = "none";
        save();
        return fail("ACME_LOGIN_DENIED", "The person said no.");
      case "expired":
        state.challenge = "none";
        save();
        return ok({ login_status: "expired" });
      default:
        return fail("ACME_LOGIN_RUNTIME", "login challenge not found");
    }
  }

  if (words[0] === "logout") {
    state.signedIn = false;
    save();
    return ok({ message: "Logged out" });
  }

  if (words[0] === "auth" && words[1] === "status") {
    if (state.auth === "error")
      return fail("ACME_AUTH_STATUS", "cannot read the web session");
    return ok({
      providers: {
        goapi: {
          state:
            state.auth === "bootstrap"
              ? "bootstrap_available"
              : (state.auth ?? "ready"),
        },
      },
    });
  }

  if (words[0] === "auth" && words[1] === "begin") {
    if (state.authChallenge === "denied")
      return fail("ACME_AUTH_DENIED", "The provider denied it.");
    if (state.authChallenge === "expired")
      return fail("ACME_AUTH_EXPIRED", "The challenge expired.");
    if (state.authFallback === "always")
      return fail(
        "ACME_AUTH_PARSE_FAILED",
        "the authorize page is incompatible",
      );
    if (state.authFallback === "once" && !args.includes("--fresh"))
      return fail(
        "ACME_AUTH_PARSE_FAILED",
        "the authorize page is incompatible",
      );
    if (state.authChallenge === "not_ready")
      return ok({
        login_status: "success",
        feishu_web_session_ready: true,
        meego_goapi_session_ready: false,
      });
    if (state.authChallenge === "approved")
      return ok({
        login_status: "success",
        feishu_web_session_ready: true,
        meego_goapi_session_ready: true,
      });
    if (qrPath) writeFileSync(qrPath, image);
    state.authChallenge = "pending";
    save();
    return ok({
      login_status: "pending",
      complete_token: "fixture-continuation-123456",
      qr_image_path: qrPath,
    });
  }

  if (words[0] === "auth" && words[1] === "complete") {
    if (state.authChallenge === "approved")
      return ok({
        login_status: "success",
        feishu_web_session_ready: true,
        meego_goapi_session_ready: true,
      });
    if (state.authChallenge === "not_ready")
      return ok({
        login_status: "success",
        feishu_web_session_ready: true,
        meego_goapi_session_ready: false,
      });
    if (state.authChallenge === "denied")
      return fail("ACME_AUTH_DENIED", "The provider denied it.");
    if (state.authChallenge === "expired")
      return ok({ login_status: "expired" });
    return ok({
      login_status: "pending",
      complete_token: "fixture-continuation-123456",
      qr_image_path: qrPath,
    });
  }

  if (words[0] === "terminal" && words[1] === "status") {
    if (state.terminal === "ready")
      return out({
        ok: true,
        identities: {
          user: { available: true },
          bot: { available: false },
        },
      });
    if (state.terminal === "upgrade")
      return out(
        { ok: false, error: { code: "CLI_PARSE_ERROR", message: "old" } },
        1,
      );
    process.stderr.write(
      state.terminal === "unknown"
        ? '{"ok":false,"error":{"type":"runtime","message":"?"}}\n'
        : '{"ok":false,"error":{"type":"config","message":"no profile"}}\n',
    );
    process.exitCode = 1;
    return;
  }

  fail("ACME_UNKNOWN", "unknown command");
}

main();
