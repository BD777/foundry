// A connector extension for tests (docs/connector-extensions.md): answers
// the protocol from state.json in its data folder, which the test writes,
// and appends every request to calls.jsonl there.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const data = process.env.FOUNDRY_EXTENSION_DATA_DIR;
const statePath = join(data, "state.json");
const read = () =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const methods = {
  initialize: () => ({ protocolVersion: read().protocolVersion ?? 1 }),
  "connector.status": () => {
    const state = read();
    if (state.statusFails) throw new Error("status could not be read");
    return {
      installed: state.installed !== false,
      version: "1.2.3",
      signedIn: Boolean(state.signedIn),
      ...(state.signedIn
        ? {
            identity: "someone@example.com",
            sites: ["cn"],
            expiresAt: state.expiresAt,
          }
        : {}),
      authorizations: [
        {
          id: "web_session",
          revision: 1,
          status: state.webSession ? "ready" : "needs_auth",
        },
      ],
    };
  },
  "connector.signIn.begin": ({ scratch, options }) => {
    const state = read();
    state.challenge = "pending";
    save(state);
    if (options.method === "code")
      return {
        status: "pending",
        codeEntry: true,
        verificationUrl: "https://sso.corp.example/approve",
      };
    writeFileSync(join(scratch, "sign-in.png"), png);
    return {
      status: "pending",
      challenge: { kind: "qr_image" },
      verificationUrl: "https://sso.corp.example/device?code=x",
    };
  },
  "connector.signIn.poll": () => {
    const state = read();
    if (state.challenge === "approved") {
      save({ ...state, challenge: "none", signedIn: true });
      return { status: "complete" };
    }
    if (state.challenge === "denied")
      return { status: "denied", error: "denied on the page" };
    return { status: "pending" };
  },
  "connector.signIn.input": ({ input }) => {
    save({
      ...read(),
      challenge: input === "good-code" ? "approved" : "denied",
    });
    return {};
  },
  "connector.signIn.cancel": () => {
    save({ ...read(), challenge: "cancelled" });
    return {};
  },
  "connector.signOut": () => {
    save({ ...read(), signedIn: false });
    return {};
  },
  "connector.install": ({ kind }) => {
    send({
      method: "connector.progress",
      params: { kind, phase: "downloading", receivedBytes: 10, totalBytes: 20 },
    });
    save({ ...read(), installed: true });
    return {};
  },
  "connector.authorization.begin": ({ scratch }) => {
    writeFileSync(join(scratch, "sign-in.png"), png);
    return {
      step: { status: "pending", challenge: { kind: "qr_image" } },
      continuation: "continuation-0123456789",
    };
  },
  "connector.authorization.poll": ({ continuation }) => {
    if (continuation !== "continuation-0123456789")
      return { status: "expired" };
    save({ ...read(), webSession: true });
    return { status: "complete" };
  },
  "modelAccess.list": () => {
    const state = read();
    if (!state.signedIn) return { profiles: [] };
    return {
      profiles: [
        {
          id: "corp_default",
          label: "Corp · default",
          runtime: "claude",
          model: "sonnet",
          models: ["sonnet", "opus"],
          identity: "namespace-1",
          session: {
            command: process.env.FOUNDRY_EXTENSION_COMMAND,
            args: ["${extensionDir}/session.mjs", "default"],
          },
        },
        {
          id: "Bad Id",
          label: "x",
          runtime: "claude",
          model: "sonnet",
          models: [],
          identity: "x",
          session: { command: "/nope" },
        },
      ],
    };
  },
};

const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  appendFileSync(
    join(data, "calls.jsonl"),
    `${JSON.stringify({ method: request.method, params: request.params, pid: process.pid, env: { home: Boolean(process.env.HOME), token: process.env.FOUNDRY_SESSION_TOKEN ?? null } })}\n`,
  );
  if (request.method === "shutdown") {
    send({ id: request.id, result: {} });
    process.exit(0);
  }
  if (read().crashOn === request.method) process.exit(3);
  try {
    send({
      id: request.id,
      result: await methods[request.method](request.params ?? {}),
    });
  } catch (error) {
    send({ id: request.id, error: { code: -32000, message: error.message } });
  }
});
