import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("one-shot Issue executor flushes its final result and exits despite SDK background handles", () => {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-executor-lifecycle-"));
  try {
    const preload = resolve(root, "sdk-background.mjs");
    writeFileSync(
      preload,
      'if (process.argv[1]?.endsWith("/issue-executor-child.js")) setInterval(() => {}, 1000);\n',
    );
    const command = resolve(root, "response.mjs");
    writeFileSync(
      command,
      'process.stdin.resume();process.stdin.on("end",()=>console.log("Synthetic completed response"));\n',
    );
    const child = resolve(
      import.meta.dirname,
      "../dist/issue-executor-child.js",
    );
    const output = execFileSync(process.execPath, [child], {
      input:
        JSON.stringify({
          cwd: root,
          session: {
            id: "run_lifecycle",
            provider: "claude",
            prompt: "Synthetic execution",
            status: "running",
          },
          profile: {
            id: "lifecycle",
            runtime: "claude",
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(command)}`,
          },
        }) + "\n",
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        FOUNDRY_EXECUTION_SESSION_ROOT: resolve(root, "sessions"),
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages.at(-1).type, "result");
    assert.equal(messages.at(-1).response, "Synthetic completed response");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
