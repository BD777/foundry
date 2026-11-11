#!/usr/bin/env node
// A stand-in for bytedcli, ported from
// foundry-private-connectors/bytedcli/reference/fake-bytedcli.mjs. It answers
// the real CLI's documented commands from $FAKE_BYTEDCLI_DIR/state.json and
// appends every call to calls.jsonl. Added here: Meego/lark status, the
// Feishu web-session begin/poll used by the additional authorization, and
// the documented one-time --session-method qr fallback.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputs = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "bytedcli-outputs.json"),
    "utf8",
  ),
);
const dir = process.env.FAKE_BYTEDCLI_DIR;
const statePath = join(dir, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
appendFileSync(
  join(dir, "calls.jsonl"),
  `${JSON.stringify({
    args,
    noAutoUpgrade: process.env.BYTEDCLI_NO_AUTO_UPGRADE ?? null,
    openQrImage: process.env.BYTEDCLI_OPEN_QR_IMAGE ?? null,
    profile: process.env.BYTEDCLI_PROFILE ?? null,
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
const writeQr = () => {
  if (qrPath) writeFileSync(qrPath, image);
};
const out = (value, code = 0) => {
  process.stdout.write(
    `${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
  process.exitCode = code;
};
const output = (name) =>
  outputs[name].replace("%QR%", qrPath ?? "/fixture/sign-in.png");

function webBegin() {
  if (state.webFallback === "always") return out(output("webParseFailed"), 1);
  if (state.webFallback === "once" && !args.includes("--session-method"))
    return out(output("webParseFailed"), 1);
  writeQr();
  state.webChallenge = "pending";
  save();
  return out(output("webBegin"));
}

function webPoll() {
  switch (state.web) {
    case "approved":
      state.web = "done";
      save();
      return out(output("webSuccess"));
    case "not_ready":
      state.web = "done";
      save();
      return out(output("webNotReady"));
    case "denied":
      state.web = "done";
      save();
      return out(output("webDenied"), 1);
    case "expired":
      state.web = "done";
      save();
      return out(output("webExpired"));
    default:
      return out(output("webPending"));
  }
}

if (args.includes("--version")) {
  out(state.version ?? "0.170.0");
} else if (words[0] === "auth" && words[1] === "status") {
  out(output(state.signedIn ? "statusSignedIn" : "statusSignedOut"));
} else if (
  words.includes("auth") &&
  words.includes("login") &&
  args.includes("--begin") &&
  !args.includes("--session")
) {
  writeQr();
  if (state.challenge === "approved") {
    state.signedIn = true;
    state.challenge = "none";
    save();
    out(output("loginSuccess"));
  } else {
    state.challenge = "pending";
    save();
    out(output("loginBegin"));
  }
} else if (
  words.includes("auth") &&
  words.includes("login") &&
  args.includes("--complete")
) {
  if (args.includes("--site")) {
    webPoll();
  } else {
    switch (state.challenge) {
      case "pending":
        out(output("loginPending"));
        break;
      case "approved":
        state.signedIn = true;
        state.challenge = "none";
        save();
        out(output("loginSuccess"));
        break;
      case "denied":
        state.challenge = "none";
        save();
        out(output("loginDenied"), 1);
        break;
      case "expired":
        state.challenge = "none";
        save();
        out(output("loginExpired"));
        break;
      default:
        out(output("runtimeError"), 1);
    }
  }
} else if (words[0] === "auth" && words[1] === "logout") {
  state.signedIn = false;
  save();
  out('{"status":"success","data":{"message":"Logged out"},"error":null}');
} else if (words.includes("meego") && words.includes("status")) {
  out(
    output(
      state.meego === "missing"
        ? "meegoMissing"
        : state.meego === "bootstrap_available"
          ? "meegoBootstrap"
          : state.meego === "other"
            ? "meegoUnknown"
            : state.meego === "error"
              ? "meegoError"
              : "meegoReady",
    ),
    state.meego === "error" ? 1 : 0,
  );
} else if (words.includes("lark")) {
  if (state.lark === "ready") out(output("larkReady"));
  else if (state.lark === "unknown")
    (process.stderr.write(`${output("larkUnknown")}\n`),
      (process.exitCode = 1));
  else if (state.lark === "parse_error")
    (process.stderr.write("not json\n"), (process.exitCode = 1));
  else if (state.lark === "upgrade") out(output("larkUpgrade"), 1);
  else
    (process.stderr.write(`${output("larkNeedsAuth")}\n`),
      (process.exitCode = 1));
} else if (
  words.includes("auth") &&
  words.includes("login") &&
  args.includes("--begin") &&
  args.includes("--session")
) {
  webBegin();
} else {
  out(
    '{"status":"error","data":null,"error":{"message":"unknown command","code":"FAKE"}}',
    1,
  );
}
