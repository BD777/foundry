import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("a blocked host loop is recorded while blocked, with its activity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fdy-host-stall-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const liveness = new URL(
    "../dist/execution-host/liveness.js",
    import.meta.url,
  ).href;
  const monitor = new URL("../dist/platform/stall-monitor.js", import.meta.url)
    .href;
  const script = `
    const { startHostLiveness } = await import(${JSON.stringify(liveness)});
    const { beginActivity } = await import(${JSON.stringify(monitor)});
    // The host's server keeps its loop alive; here a timer does.
    const alive = setInterval(() => {}, 1000);
    await startHostLiveness(${JSON.stringify(root)}, "test");
    const end = beginActivity("file copy before write Tests/A.swift");
    const until = Date.now() + 4500;
    while (Date.now() < until) {}
    end();
    await new Promise((done) => setTimeout(done, 2500));
    clearInterval(alive);
    process.exit(0);
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      FOUNDRY_EXECUTION_STALL_REPORT_MS: "2000",
      FOUNDRY_EXECUTION_STALL_LIMIT_MS: "60000",
    },
    timeout: 60_000,
  });
  const log = readFileSync(join(root, "stalls.log"), "utf8").trim().split("\n");
  const blocked = log.find((line) => line.includes("event loop blocked for"));
  assert.ok(blocked, log.join("\n"));
  assert.match(blocked, /during file copy before write Tests\/A\.swift; /);
  if (process.platform === "linux") assert.match(blocked, /state R/);
  if (process.platform === "darwin")
    assert.match(blocked, /sample .*\.sample\.txt/);
  assert.equal(log.filter((line) => line.includes("blocked for")).length, 1);
  assert.ok(
    log.some((line) =>
      /event loop ran again, about [3-5] s after its last tick/.test(line),
    ),
    log.join("\n"),
  );
});
