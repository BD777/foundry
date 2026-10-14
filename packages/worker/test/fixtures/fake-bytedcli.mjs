#!/usr/bin/env node
// A stand-in for bytedcli in tests: answers --version, auth status, auth
// login --begin / --complete and auth logout with the real CLI's output
// shapes (bytedcli-outputs.json), from a state file the test controls:
// $FAKE_BYTEDCLI_DIR/state.json { signedIn, challenge: "none" | "pending" |
// "approved" | "denied" | "expired" }. Every call is appended to calls.jsonl.
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
    profile: process.env.BYTEDCLI_PROFILE ?? null,
  })}\n`,
);
const save = () => writeFileSync(statePath, JSON.stringify(state));
const words = args.filter((arg) => !arg.startsWith("-"));

if (args.includes("--version")) {
  console.log(state.version ?? "0.170.0");
} else if (words[0] === "auth" && words[1] === "status") {
  console.log(
    state.signedIn ? outputs.statusSignedIn : outputs.statusSignedOut,
  );
} else if (
  words[0] === "auth" &&
  words[1] === "login" &&
  args.includes("--begin")
) {
  const qr = args[args.indexOf("--qr-image") + 1];
  if (qr) writeFileSync(qr, "png");
  if (state.challenge === "approved") {
    state.signedIn = true;
    state.challenge = "none";
    save();
    console.log(outputs.loginSuccess);
  } else {
    state.challenge = "pending";
    save();
    console.log(outputs.loginBegin);
  }
} else if (
  words[0] === "auth" &&
  words[1] === "login" &&
  args.includes("--complete")
) {
  switch (state.challenge) {
    case "pending":
      console.log(outputs.loginPending);
      break;
    case "approved":
      state.signedIn = true;
      state.challenge = "none";
      save();
      console.log(outputs.loginSuccess);
      break;
    case "denied":
      state.challenge = "none";
      save();
      console.log(outputs.loginDenied);
      process.exitCode = 1;
      break;
    case "expired":
      state.challenge = "none";
      save();
      console.log(outputs.loginExpired);
      break;
    default:
      console.log(outputs.runtimeError);
      process.exitCode = 1;
  }
} else if (words[0] === "auth" && words[1] === "logout") {
  state.signedIn = false;
  save();
  console.log(
    '{"status":"success","data":{"message":"Logged out"},"error":null}',
  );
} else {
  console.log(
    '{"status":"error","data":null,"error":{"message":"unknown command","code":"FAKE"}}',
  );
  process.exitCode = 1;
}
