import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { materializeSessionSkills } from "../dist/skill-materializer.js";
import { packZip } from "../dist/skill-zip.js";
import { foundryStatePath } from "../dist/state-root.js";

// Reproducible local preparation benchmark: network time intentionally excluded.
test("274 selected revisions: cold, warm, continuation and one changed revision", async () => {
  mkdirSync(foundryStatePath("skill-archives"), { recursive: true });
  let expandedBytes = 0;
  function revision(i, revision = 1) {
    const files = [
      {
        path: "SKILL.md",
        data: Buffer.from(
          `---\nname: benchmark-${i}\ndescription: Synthetic task ${i}\n---\nRevision ${revision}\n`,
        ),
      },
      ...Array.from({ length: 12 }, (_, j) => ({
        path: `references/${j}.md`,
        data: Buffer.from(`Reference ${i}/${j}\n`.repeat(1024)),
      })),
    ];
    const hash = createHash("sha256");
    for (const f of files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      hash.update(`${f.path}\0${f.data.length}\0`).update(f.data);
      expandedBytes += f.data.length;
    }
    const zip = packZip(files),
      checksum = createHash("sha256").update(zip).digest("hex");
    writeFileSync(foundryStatePath("skill-archives", `${checksum}.zip`), zip);
    return {
      skillId: `benchmark-${i}`,
      name: `benchmark-${i}`,
      revision,
      checksum,
      byteSize: zip.length,
      sourceDigest: hash.digest("hex"),
      bundle: { id: "benchmark", name: "Benchmark bundle" },
    };
  }
  const refs = Array.from({ length: 274 }, (_, i) => revision(i));
  const results = { expandedBytes };
  let first;
  for (const scenario of ["cold", "warm", "continuation", "oneUpdate"]) {
    if (scenario === "oneUpdate") refs[0] = revision(0, 2);
    const started = performance.now();
    let stats;
    const runtime = await materializeSessionSkills(
      refs,
      "http://127.0.0.1:1",
      "/unused",
      {
        onComplete: (value) => {
          stats = value;
        },
      },
    );
    results[scenario] = {
      elapsedMs: Math.round(performance.now() - started),
      ...stats,
    };
    assert.equal(stats.downloaded, 0);
    if (scenario === "warm" || scenario === "continuation") {
      assert.equal(stats.expandedCache, 274);
      assert.equal(stats.unpackMs, 0);
    }
    if (scenario === "oneUpdate") {
      assert.equal(stats.expandedCache, 273);
      assert.equal(stats.archiveCache, 1);
    }
    assert.equal(runtime.skills.length, 274);
    if (scenario === "cold") first = runtime.pluginDir;
    else if (scenario !== "oneUpdate") assert.equal(runtime.pluginDir, first);
  }
  console.log("SKILL_PREPARATION_BENCHMARK", JSON.stringify(results));
});
