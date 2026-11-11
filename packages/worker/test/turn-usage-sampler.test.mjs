import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseProcessTable,
  percentile90,
  processGroupUsage,
  TurnUsageSampler,
} from "../dist/concurrency/turn-usage-sampler.js";

test("a process group's tree is summed and zombies are ignored", () => {
  const records = [
    {
      pid: 100,
      startTime: "boot:1",
      argv: ["claude"],
      owner: { pid: 1, startTime: "boot:0" },
      context: {
        sessionId: "sess_a",
        workspaceId: "ws_a",
        runtime: "claude",
      },
    },
  ];
  const rows = parseProcessTable(
    [
      "100 100 10.0 100000 S",
      "101 100 5.0 200000 R",
      "102 100 0.0 900000 Z",
      "200 200 50.0 500000 R",
    ].join("\n"),
  );
  assert.deepEqual(processGroupUsage(records, rows).get("sess_a"), {
    cpuCores: 0.15,
    processCount: 2,
    rssBytes: 300000 * 1024,
  });
});

test("P90 uses the observed per-turn peaks", () => {
  assert.equal(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(percentile90([]), undefined);
});

test("estimates survive a restart and use conservative priors when empty", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-turn-usage-"));
  const path = join(root, "estimates.json");
  try {
    const empty = new TurnUsageSampler(path);
    assert.equal(
      empty.estimate("ws_a", "claude").peakRssBytes,
      1.5 * 1024 ** 3,
    );

    const sampler = new TurnUsageSampler(path);
    for (const [sessionId, rss, cpu] of [
      ["one", 600 * 1024 ** 2, 0.2],
      ["two", 800 * 1024 ** 2, 0.4],
      ["three", 700 * 1024 ** 2, 0.3],
    ]) {
      sampler.observe({
        sessionId,
        workspaceId: "ws_a",
        runtime: "claude",
        currentRssBytes: rss,
        currentCpuCores: cpu,
      });
    }
    sampler.finishMissing(new Set());
    sampler.save(true);

    const restored = new TurnUsageSampler(path).estimate("ws_a", "claude");
    assert.equal(restored.peakRssBytes, 800 * 1024 ** 2);
    assert.ok(restored.typicalRssBytes > 400 * 1024 ** 2);
    assert.ok(restored.averageCpuCores > 0.3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
