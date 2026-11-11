// Minimal program extension: read the login with `acme whoami --json` and
// leave signing in to the terminal method declared in the manifest.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const whoami = () =>
  new Promise((resolve) =>
    execFile(
      "acme",
      ["whoami", "--json"],
      { timeout: 20_000 },
      (error, stdout) =>
        resolve(
          error?.code === "ENOENT"
            ? { installed: false }
            : { installed: true, error, stdout },
        ),
    ),
  );

const methods = {
  initialize: () => ({ protocolVersion: 1 }),
  "connector.status": async () => {
    const run = await whoami();
    if (!run.installed) return { installed: false, signedIn: false };
    if (run.error) return { installed: true, signedIn: false };
    const me = JSON.parse(run.stdout);
    return {
      installed: true,
      version: me.version,
      signedIn: true,
      identity: me.user,
      expiresAt: me.expiresAt,
    };
  },
  shutdown: () => {
    setImmediate(() => process.exit(0));
    return {};
  },
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  const handler = methods[method];
  if (!handler)
    return send({
      id,
      error: { code: -32601, message: `${method} is not supported` },
    });
  try {
    send({ id, result: await handler(params) });
  } catch (error) {
    send({
      id,
      error: { code: -32000, message: String(error.message).slice(0, 300) },
    });
  }
});
process.stdin.on("end", () => process.exit(0));
